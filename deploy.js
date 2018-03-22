const aws = require('aws-sdk');
const childProcess = require('child_process');
const co = require('co');
const debug = require('debug');
const fs = require('fs');
// const uuid = require('uuid');
// const moment = require('moment');
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
    lambdaDeploymentsPrefix: 'deployments' 
};

const Parameters = {
    email: 'mail@example.com',
    uid: 'deafault-value' //uuid();
};

function expectedArchiveName(packageConfig) {
    return packageConfig.name.replace(/^@/, '').replace(/\//, '-') + '-' + packageConfig.version + '.tgz';
}


async function deleteQuokka() {
    let result = {};

    const spinner = new Spinner();
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

    logInfo(result);
}

async function installQuokka() {    
    let result = {};
    
    const spinner = new Spinner();
    spinner.setSpinnerString(11);

    let cform = new aws.CloudFormation();

    spinner.setSpinnerTitle('Tracking down Quokka');
    spinner.start();

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

    const bucketName = `tmp-${Consts.bucketNameBase}-${Parameters.uid}`.toLowerCase();

    // Lambda code path
    const codePath = path.join(__dirname, Consts.codeDirName);

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

    logInfo('Creating code deloyment package');
    
    const packageConfig = JSON.parse(fs.readFileSync('./lambda/package.json', 'utf8'));
    const packArchiveName = expectedArchiveName(packageConfig);    
    const packArchivePath = path.join(codePath, packArchiveName);

    childProcess.execSync('npm pack', {cwd: codePath});
    
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

    const templateKey = `${Consts.lambdaDeploymentsPrefix}/${Consts.templateFileName}`;
    const codeKey = `${Consts.lambdaDeploymentsPrefix}/${Consts.lambdaFileName}`;
    const templateUrl = {
        TemplateURL: `http://s3.amazonaws.com/${bucketName}/${templateKey}`
    };
    
    await cform.validateTemplate(templateUrl).promise();

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

    spinner.start();

    const stackId = result.StackId;
    let completed = false;
    let stackStatus = '?';
    do {
        spinner.setSpinnerTitle(`Creating CloudFormation stack:; status = ${stackStatus}`);
        result = await cform.describeStacks({StackName: stackId}).promise();
        stackStatus = result.Stacks[0].StackStatus;
        completed = stackStatus != 'CREATE_IN_PROGRESS';
    } while (!completed);

    spinner.stop(true);

    if (stackStatus !== 'CREATE_COMPLETE') {
        throw new Error('CloudFormation not created');
    }
    
    logInfo(`Stack: ${logInfo(result.Stacks[0].StackId)}`);
    logInfo(`Status: ${stackStatus}`);
    logInfo(`Outputs: ${JSON.stringify(result.Stacks[0].Outputs, null, 2)}`);  
};

aws.config.update({region: Consts.awsRegion});

try {
    installQuokka();    
    // deleteQuokka();
} catch (err) {
    logError(err);
}