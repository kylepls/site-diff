import {GetObjectCommand, PutObjectCommand, S3Client} from "@aws-sdk/client-s3";
import {SendEmailCommand, SESClient} from "@aws-sdk/client-ses";
import resemble from "resemblejs";
import moment from "moment-timezone"
import chromium from "chrome-aws-lambda";

const DIFF_THRESHOLD = 0.01;
const TARGET_URL = 'https://sightmap.com/embed/k9zw4gr6w87'

const REGION = 'us-east-1';
const BUCKET_NAME = 'kylepls-site-diff';

const LAST_IMAGE_KEY = 'last-screenshot.png';
const TO_EMAIL = 'mail@kyle.in'
const FROM_EMAIL = 'mail@kyle.in'

const s3 = new S3Client({region: REGION});
const ses = new SESClient({region: REGION});

export const run = async () => {
    try {
        // Launch Puppeteer
        const browser = await chromium.puppeteer
            .launch({
                args: chromium.args,
                defaultViewport: chromium.defaultViewport,
                executablePath: await chromium.executablePath,
                headless: chromium.headless
            });

        const page = await browser.newPage();

        // Navigate to the website
        const url = new URL(TARGET_URL).toString();
        console.info(`Navigating to ${url}...`)
        await page.goto(url, {waitUntil: 'networkidle0'});
        await page.click('#Layer_1')
        await page.waitForTimeout(1000)

        // Take a screenshot of the current page
        console.info('Taking a screenshot...')
        const currentScreenshot = await page.screenshot();

        // Compare with the previous screenshot
        console.info('Retrieving previous screenshot...')
        const lastScreenshot = await getPreviousScreenshot();

        console.info('Calculating diff...')
        const diff = await compareScreenshots(currentScreenshot, lastScreenshot);
        console.log('diff', diff)

        if (diff.rawMisMatchPercentage < DIFF_THRESHOLD) {
            console.info('No diff, mismatch is low')
            return
        }
        const diffImage = diff.getBuffer()

        const filesPath = `diff/${Date.now()}`
        // Upload the diff image to S3
        console.info('Uploading image diff...')
        const diffS3Name = await uploadToS3(diffImage, `${filesPath}/diff.png`);

        console.log('Recording new/old image to diff...')
        const oldS3Name = await uploadToS3(lastScreenshot, `${filesPath}/old.png`)
        const newS3Name = await uploadToS3(currentScreenshot, `${filesPath}/new.png`)

        // Send email
        console.info('Sending email notification...')
        await sendEmail(diffS3Name, oldS3Name, newS3Name)

        // Save the current screenshot as the new previous screenshot
        console.info('Uploading current version as last image')
        await saveCurrentScreenshot(currentScreenshot);

        // Close Puppeteer
        await browser.close();
        console.info('Done.')

        return {
            statusCode: 200,
            body: 'Website screenshot captured successfully.',
        };
    } catch (error) {
        console.error('Error:', error);
        return {
            statusCode: 500,
            body: 'An error occurred while capturing the website screenshot.',
        };
    }
};


async function getPreviousScreenshot() {
    try {
        const params = {
            Bucket: BUCKET_NAME,
            Key: LAST_IMAGE_KEY,
        };
        const data = await s3.send(new GetObjectCommand(params));
        const lastScreenshot = await streamToBuffer(data.Body);
        return lastScreenshot;
    } catch (error) {
        // Return a blank image if the previous screenshot doesn't exist
        return null
    }
}

async function compareScreenshots(currentScreenshot, lastScreenshot) {
    if (!lastScreenshot) console.info('No last screenshot, using current...')
    const diff = resemble(lastScreenshot || currentScreenshot)
        .compareTo(currentScreenshot)
        .ignoreColors()
    return await new Promise(resolve => diff.onComplete(resolve))
}

async function uploadToS3(diffImage, name = `diff-${Date.now()}.png`) {
    const params = {
        Bucket: BUCKET_NAME,
        Key: name,
        Body: diffImage,
        ContentType: 'image/png',
    };
    await s3.send(new PutObjectCommand(params));
    return name
}

async function saveCurrentScreenshot(currentScreenshot) {
    const params = {
        Bucket: BUCKET_NAME,
        Key: LAST_IMAGE_KEY,
        Body: currentScreenshot,
        ContentType: 'image/png',
    };
    await s3.send(new PutObjectCommand(params));
}

async function streamToBuffer(stream) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        stream.on('data', (chunk) => chunks.push(chunk));
        stream.on('error', reject);
        stream.on('end', () => resolve(Buffer.concat(chunks)));
    });
}

async function sendEmail(diffImage, oldImage, newImage) {

    const s3Prefix = `${BUCKET_NAME}.s3.${REGION}.amazonaws.com/`

    const timeFormatted = moment().tz('America/Los_Angeles').format('ddd MMMM Do, h:mm:ss a')
    const timeFormattedSimple = moment().tz('America/Los_Angeles').format('ddd h:mm a')

    const params = {
        Source: FROM_EMAIL,
        Destination: {
            ToAddresses: [TO_EMAIL],
        },
        Message: {
            Subject: {Data: `Website Screenshot Difference on ${timeFormattedSimple}`},
            Body: {
                Html: {
                    Data: `
                        <h1>Website Screenshot Difference</h1>
                        <p>Reported on ${timeFormatted}</p>
                        <h2>Diff</h2>
                        <img src="${s3Prefix}${diffImage}" alt="">
                        <h2>Old Image</h2>
                        <img src="${s3Prefix}${oldImage}" alt="">
                        <h2>New Image</h2>
                        <img src="${s3Prefix}${newImage}" alt="">
                    `,
                    Charset: 'UTF-8',
                },
            },
        },
    };
    await ses.send(new SendEmailCommand(params));
}

