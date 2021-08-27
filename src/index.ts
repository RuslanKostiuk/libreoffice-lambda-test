import 'source-map-support/register'
import { S3 } from 'aws-sdk'
import { v4 } from 'uuid'
import { createLogger, transports, Logger } from 'winston'
import { cleanEnv, str, bool } from 'envalid'
import { file, FileResult } from 'tmp-promise';
import { promises } from 'fs';
import * as path from 'path';
import { unpack } from '@shelf/aws-lambda-libreoffice';
const { execSync } = require('child_process');


// we can use "convertTo" function from @shelf/aws-lambda-libreoffice
// but in this case we will face with this issue https://github.com/shelfio/aws-lambda-libreoffice/issues/130
// it is related to the same error as ours
const convertCommand = `export HOME=/tmp && ./instdir/program/soffice.bin --headless --norestore --invisible --nodefault --nofirststartwizard --nolockcheck --nologo --convert-to "pdf:writer_pdf_Export" --outdir /tmp`;

interface Request {
    bucket: string
    prefix: string
    key: string
}

interface EnvironmentConfig {
    /**
     * Default bucket to download files from
     */
    DOWNLOAD_BUCKET_NAME: string,
    /**
     * Level of logging to perform
     */
    LOG_LEVEL: string
    /**
     * Where final file will be uploaded to
     */
    UPLOAD_BUCKET_NAME: string
    /**
     * Use S3 for upload/download (default: true)
     */
    USE_S3: boolean
}

class DocxToPdf {
    private readonly logger: Logger
 
    constructor(private readonly config: EnvironmentConfig) {
        this.logger = createLogger({
            level: config.LOG_LEVEL,
            transports: [new transports.Console()]
        });
    }

    run(events: Request[]): Promise<Object> {
        return Promise.all(events.map(async (event: Request) => {
            const body = await this._downloadFile(event.prefix + "/" + event.key);
            const buffer = await this._start(body, event.key);
            const fileName = event.key.substr(0, event.key.lastIndexOf("."));
            let s3Result = await this._save(fileName, buffer);
            return {
                ...s3Result,
                size: buffer.length
            };
        }));
    };

    private async _downloadFile(fileKey: string) {
        const s3 = new S3();
        const data = await s3.getObject({
            Bucket: this.config.DOWNLOAD_BUCKET_NAME,
            Key: fileKey
        }).promise();
        return data.Body.toString("utf-8");
    }

    private async _save(fileName: string, body: S3.Body) {
        const s3 = new S3();

        const name = fileName + ".pdf";
        const uuidPrefix = v4();

        if (this.config.USE_S3) {
            this.logger.debug(`Storing to S3: ${this.config.UPLOAD_BUCKET_NAME}`);
            await s3.putObject({
                Bucket: this.config.UPLOAD_BUCKET_NAME,
                Key: `${uuidPrefix}/${name}`,
                ContentDisposition: `attachment; filename=${name}`,
                Body: body,
                ACL: "private",
                ServerSideEncryption: "AES256"
            }).promise();

            return {
                prefix: uuidPrefix,
                key: name
            }
        }
        else {
            this.logger.debug(`Storing to local storage.`);
            return {
                prefix: uuidPrefix,
                key: name,
                tmpFilePath: await this._saveToTmp(body)
            };
        }
    }

    private async _saveToTmp(data: S3.Body): Promise<string> {
        const doc: FileResult = await file({ postfix: 'pdf'});
        await promises.writeFile(doc.path, data as Buffer);
        return doc.path;
    }

    private async _start(body: S3.Body, filename: string): Promise<Buffer> {
        await promises.writeFile(`/tmp/${filename}`, body as Buffer);
        try {
            // First run will produce predictable error, because of unknown issues
            // https://github.com/vladgolubev/serverless-libreoffice and
            // https://github.com/shelfio/aws-lambda-libreoffice use the same workaround
            execSync(`cd /tmp && ${convertCommand} ${filename}`);
        } catch (e) {
            execSync(`cd /tmp && ${convertCommand} ${filename}`);
        }
        return promises.readFile(`/tmp/${path.parse(filename).name}.pdf`);
    }
}

export const handler = async (event: any = {}): Promise<any> => {
    await unpack({ inputPath: '/opt/lo.tar.br' });
    return (new DocxToPdf(cleanEnv(process.env, {
        DOWNLOAD_BUCKET_NAME: str(),
        LOG_LEVEL: str({default: 'info', choices: ['info','error','debug','warn']}),
        UPLOAD_BUCKET_NAME: str(),
        USE_S3: bool({default: true}),
    }))).run(event)
}
