const aws = require('aws-sdk');
const childProcess = require('child_process');
const co = require('co');
const debug = require('debug');
const fs = require('fs');
const uuid = require('uuid');
const parseArgs = require('minimist')
const path = require('path');
const {pack} = require('./packager');
const {Spinner} = require('cli-spinner');

const logInfo = debug('quokka:info');
const logError = debug('quokka:error');

const Consts = {
    stackName: 'Quokka',
    awsRegion: 'us-east-1',
    codeDirName: 'lambda',
    bucketNameBase: 'quokka-data',
    templateFileName: 'quokka.cform',
    lambdaFileName: 'quokka-lambda.zip',
    lambdaDeploymentsPrefix: 'deployments',
    installerPolicyName: 'QuokkaInstallerPolicy'
};

const Parameters = {
    email: 'mail@example.com',
    uid: uuid()
};

function expectedArchiveName(packageConfig) {
    return packageConfig.name.replace(/^@/, '').replace(/\//, '-') + '-' + packageConfig.version + '.tgz';
}

aws.config.update({region: Consts.awsRegion});
const spinner = new Spinner();

async function waitForStackStatus(stackId, status, spinner, cform) {
    spinner.start();



    let completed = false;
    let stackStatus = '?';
    do {
        spinner.setSpinnerTitle(`Waiting for CloudFormation stack:; status = ${stackStatus}`);
        result = await cform.describeStacks({StackName: stackId}).promise();
        stackStatus = result.Stacks[0].StackStatus;
        completed = stackStatus != status;
    } while (!completed);

    spinner.stop(true);
    return result.Stacks[0];
}

async function uninstallQuokka() {
    let result = {};

    spinner.setSpinnerString(11);

    let cform = new aws.CloudFormation();

    try {
        result = await cform.describeStacks({StackName: Consts.stackName}).promise();
    } catch (err) {
        logError('Quokka stack not found');
        return;
    }

    const stack = result.Stacks[0];
    logInfo(`We got one!\nStackId: ${stack.StackId}`);

    spinner.setSpinnerTitle('Uninstalling Quokka');
    spinner.start();

    result = await cform.deleteStack({StackName: Consts.stackName}).promise();

    spinner.stop(true);

    result = await waitForStackStatus(stack.StackId, 'DELETE_IN_PROGRESS', spinner, cform);
    console.log(result);
    if (stack.StackStatus !== 'DELETE_COMPLETE') {
        throw new Error('CloudFormation not deleted');
    }

    logInfo(result);
}

async function installQuokka() {
    let result = {};

    spinner.setSpinnerString(11);

    // Make sure we have all the rights
    spinner.setSpinnerTitle('Fetching user');
    spinner.start();
    let iam = new aws.IAM();

    const user = await iam.getUser().promise();
    const match = /^arn:aws:iam:[^:]*:([0-9]+):.*$/.exec(user.User.Arn);
    const accountId = match[1];

    spinner.setSpinnerTitle(`Preparing user policy; user='${user.User.UserName}:${accountId}'`);

    const policyStr = fs.readFileSync('installer-policy.json', 'utf-8');
    const policy = JSON.parse(policyStr);
    const requestedActions = new Set();
    for (let statement of policy.Statement) {
        if (statement.Resource) {
            // Resources defined = skip statement
            continue;
        }

        // Gather all services
        let services = statement.Action.reduce((accum, action) => {
            requestedActions.add(action);
            accum.add(action.substring(0, action.indexOf(':')));
            return accum;
        }, new Set());

        // Build restricted access arn resources
        // `arn:partition:service:region:account-id:resource`
        if (services.size) {
            let resources = [];
            const regionalServices = ['s3', 'iam'];
            const accountServices = ['s3', 'apigateway'];
            services.forEach(service => {
                const regionSpecific = regionalServices.indexOf(service) == -1;
                const usesAccountId = accountServices.indexOf(service) == -1;
                let arn = `arn:aws:${service}:${regionSpecific ? Consts.awsRegion : ''}:${usesAccountId ? accountId : ''}:*`;
                if (resources.indexOf(arn) == -1) {
                    resources.push(arn);
                }
            })
            statement.Resource = resources.length == 1 ? resources[0] : resources;
        }
    }

    spinner.setSpinnerTitle(`Setting user policy; user='${user.User.UserName}:${accountId}'`);

    try {
        await iam.putUserPolicy( {
            PolicyDocument: JSON.stringify(policy),
            PolicyName: Consts.installerPolicyName,
            UserName: user.User.UserName
        }).promise();
    } catch (error) {
        logError('Failed to install policy', error);
        logError('Policy', JSON.stringify(policy, null, ' '));
    }

    spinner.setSpinnerTitle(`Verifying user policy; user='${user.User.UserName}:${accountId}'`);

    // Wait for policies to be installed
    let fetchedPolicy
    do {
        try {
            const result = await iam.getUserPolicy( {
                PolicyName: Consts.installerPolicyName,
                UserName: user.User.UserName
            }).promise();

            fetchedPolicy = JSON.parse(unescape(result.PolicyDocument.toString()));
        } catch (err) {
            fetchedPolicy = null;
        }
    } while (!fetchedPolicy);

    // Verify if all rights are set
    for (let statement of fetchedPolicy.Statement) {
        let actions = Array.isArray(statement.Action) ? statement.Action : (typeof statement.Action == 'string' ? [statement.Action] : false);
        if (!actions) {
            continue
        }

        for (let action of actions) {
            requestedActions.delete(action);
        }
    }
    spinner.stop();

    // Installer should fail at this point
    if (requestedActions.size != 0) {
        logError('Missing required actions', requestedActions.values());
    }

    // Check if Quokka is already installed
    spinner.setSpinnerTitle('Tracking down Quokka');
    spinner.start();
    let cform = new aws.CloudFormation();

    try {
        result = await cform.describeStacks({StackName: Consts.stackName}).promise();
        spinner.stop(true);

        const stack = result.Stacks[0];
        logInfo(`We got one!\nStackId: ${stack.StackId}\nOutputs:`);
        for (var output of stack.Outputs) {
            let info = `\t${output.OutputKey}: ${output.OutputValue}`;
            if (output.Description) {
                info += `\n\t${output.Description}`;
            }
            info += '\n'
            logInfo(info);
        }

        return;
    } catch(err) {
        spinner.stop(true);
        logInfo('Quokka stack not found');
    }

    // Temporary Quokka bucket
    const bucketName = `tmp-${Consts.bucketNameBase}-${Parameters.uid}`.toLowerCase();

    // Create bucket
    const s3 = new aws.S3();
    const bucket = {
        Bucket: bucketName
    };
    try {
        result = await s3.headBucket(bucket).promise();
        logInfo(`Bucket '${bucketName}' already exists`);
    } catch (e) {
        logInfo(`Creating new bucket '${bucketName}`);
        await s3.createBucket(bucket).promise();
    }

    // Prepare Lambda code package
    logInfo('Creating code deloyment package');

    // Lambda code path
    const codePath = path.join(__dirname, Consts.codeDirName);
    const packageConfig = JSON.parse(fs.readFileSync('./lambda/package.json', 'utf8'));
    const packArchiveName = expectedArchiveName(packageConfig);
    const packArchivePath = path.join(codePath, packArchiveName);

    // Pack Lambda sources
    childProcess.execSync('npm pack', {cwd: codePath});

    // Build complete Lambda deployment package (code + node_modules)
    await pack({
        bucket: bucketName,
        inkey: packArchivePath,
        outkey: path.join(__dirname, Consts.lambdaFileName),
        disableUpload: true,
        logInfo: function(log) { logInfo(`\t↳ ${log}`); }
    });

    fs.unlinkSync(packArchivePath);

    spinner.setSpinnerTitle('Uploading code package and template');
    spinner.start();

    await Promise.all([
        Consts.lambdaFileName,
        Consts.templateFileName
    ].map(function(fileName) {
        return s3.putObject(Object.assign(bucket,{
            Key: `${Consts.lambdaDeploymentsPrefix}/${fileName}`,
            Body: fs.createReadStream(fileName)
        })).promise();
    }));

    spinner.stop(true);
    logInfo('Uploaded code package and template');

    // Validate CloudFormation stack definition
    const templateKey = `${Consts.lambdaDeploymentsPrefix}/${Consts.templateFileName}`;
    const codeKey = `${Consts.lambdaDeploymentsPrefix}/${Consts.lambdaFileName}`;
    const templateUrl = {
        TemplateURL: `http://s3.amazonaws.com/${bucketName}/${templateKey}`
    };

    await cform.validateTemplate(templateUrl).promise();

    // Create CloudFormation stack
    result = await cform.createStack(Object.assign(templateUrl, {
        StackName: Consts.stackName,
        Parameters: [
            {
                ParameterKey: 'Email',
                ParameterValue: Parameters.email
            },
            {
                ParameterKey: 'UID',
                ParameterValue: Parameters.uid
            },
            {
                ParameterKey: 'CodeBucket',
                ParameterValue: bucketName
            },
            {
                ParameterKey: 'CodeKey',
                ParameterValue: codeKey
            }
        ],
        Capabilities: [
            'CAPABILITY_IAM'
        ]
    })).promise();

    const stack = await waitForStackStatus(result.StackId, 'CREATE_IN_PROGRESS', spinner, cform);
    if (stack.StackStatus !== 'CREATE_COMPLETE') {
        throw new Error('CloudFormation not created');
    }

    logInfo(`Stack: ${stack.StackId}`);
    logInfo(`Status: ${stack.StackStatus}`);
    logInfo(`Outputs: ${JSON.stringify(stack.Outputs, null, 2)}`);

    // Save installation details
    let stackInfo = {
        name: stack.StackName,
        id: stack.StackId,
        createdAt: stack.CreationTime,
        outputs: stack.Outputs
    }
    fs.writeFileSync('quokka.json',JSON.stringify(stackInfo, null, 2))

    // @todo Revoke all installer policies
};

const argv = parseArgs(process.argv.slice(2));
try {
    switch (argv.task) {
        case 'install':
                const email = argv.email;
                Parameters.email = email;
                installQuokka();
            break;
        case 'uninstall':
                uninstallQuokka();
            break;
    }
} catch (err) {
    logError(err);
}
