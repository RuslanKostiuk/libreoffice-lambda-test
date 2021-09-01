import { S3 } from 'aws-sdk'
import { v4 } from 'uuid'
import { createLogger, transports, Logger } from 'winston'
import { cleanEnv, str, bool } from 'envalid'
import { file, FileResult } from 'tmp-promise';
import { promises } from 'fs';
import { convertTo, unpack } from '@shelf/aws-lambda-libreoffice';

interface FileData {
    id: number,
    prefix: string,
    key: string,
    size: number,
    tmpFilePath?: string,
}

interface EnvironmentConfig {
    /**
     * Default bucket to download files from
     */
    DOWNLOAD_BUCKET_NAME: string,
    /**
     * Level of logging to perform
     */
    LOG_LEVEL: string,
    /**
     * Where final file will be uploaded to
     */
    UPLOAD_BUCKET_NAME: string,
    /**
     * Use S3 for upload/download (default: true)
     */
    USE_S3: boolean,
}

class DocxToPdf {
    private readonly logger: Logger;
 
    constructor(private readonly config: EnvironmentConfig) {
        this.logger = createLogger({
            level: config.LOG_LEVEL,
            transports: [new transports.Console()],
        });
    }

    run(events: FileData[]): Promise<Object> {
        return Promise.all(events.map(async (event: FileData): Promise<FileData> => {
            const body = await this._downloadFile(`${event.prefix}/${event.key}`);
            const buffer = await this._start(body, event.key);
            const fileName = event.key.substr(0, event.key.lastIndexOf('.'));
            let s3Result = await this._save(fileName, buffer);
            return {
                ...s3Result,
                id: event.id,
                size: buffer.length,
            };
        }));
    };

    private async _downloadFile(fileKey: string): Promise<Buffer> {
        const s3 = new S3();
        const data = await s3.getObject({
            Bucket: this.config.DOWNLOAD_BUCKET_NAME,
            Key: fileKey,
        }).promise();
        return data.Body as Buffer;
    }

    private async _save(fileName: string, body: S3.Body): Promise<FileData> {
        const s3 = new S3();

        const name = `${fileName}.pdf`;
        const uuidPrefix = v4();

        if (this.config.USE_S3) {
            this.logger.debug(`Storing to S3: ${this.config.UPLOAD_BUCKET_NAME}`);
            await s3.putObject({
                Bucket: this.config.UPLOAD_BUCKET_NAME,
                Key: `${uuidPrefix}/${name}`,
                ContentDisposition: `attachment; filename=${name}`,
                Body: body,
                ACL: 'private',
                ServerSideEncryption: 'AES256',
            }).promise();

            return {
                prefix: uuidPrefix,
                key: name,
            } as FileData;
        }
        else {
            this.logger.debug(`Storing to local storage.`);
            return {
                prefix: uuidPrefix,
                key: name,
                tmpFilePath: await this._saveToTmp(body),
            } as FileData;
        }
    }

    private async _saveToTmp(data: S3.Body): Promise<string> {
        const doc: FileResult = await file({ postfix: 'pdf'});
        await promises.writeFile(doc.path, data as Buffer);
        return doc.path;
    }

    private async _start(body: S3.Body, filename: string): Promise<Buffer> {
        await promises.writeFile(`/tmp/${filename}`, body as Buffer);
        const resultPath: string = await convertTo(filename, 'pdf');
        const result: Buffer = await promises.readFile(resultPath);
        await promises.unlink(resultPath);
        return result;
    }
}

export const handler = async (event: any = {}): Promise<any> => {
    await unpack({ inputPath: '/opt/lo.tar.br' });
    return (new DocxToPdf(cleanEnv(process.env, {
        DOWNLOAD_BUCKET_NAME: str(),
        LOG_LEVEL: str({ default: 'info', choices: ['info','error','debug','warn'] }),
        UPLOAD_BUCKET_NAME: str(),
        USE_S3: bool({ default: true} ),
    }))).run(event);
}
