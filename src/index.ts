import {
  type PutObjectCommandInput,
  type S3ClientConfig,
  type ObjectCannedACL,
  S3,
} from '@aws-sdk/client-s3'
import StorageBase, { type ReadOptions, type Image } from 'ghost-storage-base'
import { join } from 'path'
import { createReadStream, readFileSync, writeFileSync } from 'fs'
import type { Readable } from 'stream'
import type { Handler } from 'express'
import imageTransform from '@tryghost/image-transform';

const THEME_PATH = process.env.THEME_PATH || 'current/core/frontend/services/themes/active/package.json';
const activeTheme = require(join(process.cwd(), THEME_PATH));

const stripLeadingSlash = (s: string) =>
  s.indexOf('/') === 0 ? s.substring(1) : s
const stripEndingSlash = (s: string) =>
  s.indexOf('/') === s.length - 1 ? s.substring(0, s.length - 1) : s
const normalizePath = (filePath) => {
  return filePath.replace(/\\/g, '/');
};

type Config = {
  accessKeyId?: string
  assetHost?: string
  bucket?: string
  pathPrefix?: string
  region?: string
  secretAccessKey?: string
  endpoint?: string
  forcePathStyle?: boolean
  acl?: string
}

interface ImageSize {
  width?: number;
  height?: number;
}

interface ImageSizes {
  [key: string]: ImageSize;
}

class S3Storage extends StorageBase {
  accessKeyId?: string
  secretAccessKey?: string
  region?: string
  bucket?: string
  host: string
  pathPrefix: string
  endpoint: string
  forcePathStyle: boolean
  acl?: ObjectCannedACL

  constructor(config: Config = {}) {
    super()

    const {
      accessKeyId,
      assetHost,
      bucket,
      pathPrefix,
      region,
      secretAccessKey,
      endpoint,
      forcePathStyle,
      acl,
    } = config

    // Compatible with the aws-sdk's default environment variables
    this.accessKeyId = accessKeyId
    this.secretAccessKey = secretAccessKey
    this.region = process.env.AWS_DEFAULT_REGION || region

    this.bucket = process.env.GHOST_STORAGE_ADAPTER_S3_PATH_BUCKET || bucket

    if (!this.bucket) throw new Error('S3 bucket not specified')

    // Optional configurations
    this.forcePathStyle =
      Boolean(process.env.GHOST_STORAGE_ADAPTER_S3_FORCE_PATH_STYLE) ||
      Boolean(forcePathStyle) ||
      false

    let defaultHost: string

    if (this.forcePathStyle) {
      defaultHost = `https://s3${
        this.region === 'us-east-1' ? '' : `.${this.region}`
      }.amazonaws.com/${this.bucket}`
    } else {
      defaultHost = `https://${this.bucket}.s3${
        this.region === 'us-east-1' ? '' : `.${this.region}`
      }.amazonaws.com`
    }

    this.host =
      process.env.GHOST_STORAGE_ADAPTER_S3_ASSET_HOST ||
      assetHost ||
      defaultHost

    this.pathPrefix = stripLeadingSlash(
      normalizePath(process.env.GHOST_STORAGE_ADAPTER_S3_PATH_PREFIX || pathPrefix || '')
    )
    this.endpoint =
      process.env.GHOST_STORAGE_ADAPTER_S3_ENDPOINT || endpoint || ''
    this.acl = (process.env.GHOST_STORAGE_ADAPTER_S3_ACL ||
      acl ||
      'public-read') as ObjectCannedACL
  }

  async delete(fileName: string, targetDir?: string) {
    const directory = targetDir || this.getTargetDir(this.pathPrefix)

    try {
      await this.s3().deleteObject({
        Bucket: this.bucket,
        Key: stripLeadingSlash(normalizePath(join(directory, fileName))),
      })
    } catch {
      return false
    }
    return true
  }

  async exists(fileName: string, targetDir?: string) {
    try {
      await this.s3().getObject({
        Bucket: this.bucket,
        Key: stripLeadingSlash(
          normalizePath(targetDir ? join(targetDir, fileName) : fileName)
        ),
      })
    } catch {
      return false
    }
    return true
  }

  s3() {
    const options: S3ClientConfig = {
      region: this.region,
      forcePathStyle: this.forcePathStyle,
    }

    // Set credentials only if provided, falls back to AWS SDK's default provider chain
    if (this.accessKeyId && this.secretAccessKey) {
      options.credentials = {
        accessKeyId: this.accessKeyId,
        secretAccessKey: this.secretAccessKey,
      }
    }

    if (this.endpoint !== '') {
      options.endpoint = this.endpoint
    }
    return new S3(options)
  }

  // Doesn't seem to be documented, but required for using this adapter for other media file types.
  // Seealso: https://github.com/laosb/ghos3/pull/6
  urlToPath(url: string) {
    const parsedUrl = new URL(url)
    return parsedUrl.pathname
  }

  async save(image: Image, targetDir?: string) {
    const directory = targetDir || this.getTargetDir("");

    const fileName = await this.getUniqueFileName(image, "")
    const file = createReadStream(image.path)
    const fileFormat = image.name.split('.').pop();
    const targetFilename = image.name.split('/').pop().split('.').slice(0, -1).join('.');
    const isOriginalImage = targetFilename.endsWith('_o');

    if (!isOriginalImage && activeTheme && activeTheme.config && activeTheme.config.image_sizes && imageTransform.canTransformToFormat(fileFormat)) {
      const imageSizes: ImageSizes = activeTheme.config.image_sizes;
      // Compute image dimensions
      const imageDimensions = Object.keys(imageSizes).reduce<{ [key: string]: ImageSize }>((dimensions, size) => {
        const { width, height } = imageSizes[size];
        const dimension = (width ? 'w' + width : '') + (height ? 'h' + height : '');
        return Object.assign({
            [dimension]: imageSizes[size]
        }, dimensions);
      }, {});

      const data = readFileSync(image.path);
      const resizePromises = Object.keys(imageDimensions).map((imageDimension) => {
        const transformed = imageTransform.resizeFromBuffer(data, {
          ...imageDimensions[imageDimension],
          format: fileFormat
        });
        const awsFileName = normalizePath(join(stripEndingSlash(this.pathPrefix), stripEndingSlash(directory), `/size/${imageDimension}/${fileName}`));
        return this.uploadFile(transformed, awsFileName, image.type);
      });

      await Promise.all(resizePromises);
    }

    const directoryCommon = targetDir || this.getTargetDir(this.pathPrefix);
    const awsFileNameCommon = await this.getUniqueFileName(image, directoryCommon);
    await this.uploadFile(file, awsFileNameCommon, image.type);
    return `${this.host}/${awsFileNameCommon}`;
  }

  private async uploadFile(file: Readable | Buffer, fileName: string, contentType: string) {
    let config: PutObjectCommandInput = {
      ACL: this.acl,
      Body: file,
      Bucket: this.bucket,
      CacheControl: `max-age=${30 * 24 * 60 * 60}`,
      ContentType: contentType,
      Key: stripLeadingSlash(normalizePath(fileName)),
    }
    await this.s3().putObject(config)
  }


  serve(): Handler {
    return async (req, res, next) => {
      try {
        const output = await this.s3().getObject({
          Bucket: this.bucket,
          Key: stripLeadingSlash(stripEndingSlash(this.pathPrefix) + normalizePath(req.path)),
        })

        const headers: { [key: string]: string } = {}
        if (output.AcceptRanges) headers['accept-ranges'] = output.AcceptRanges
        if (output.CacheControl) headers['cache-control'] = output.CacheControl
        if (output.ContentDisposition)
          headers['content-disposition'] = output.ContentDisposition
        if (output.ContentEncoding)
          headers['content-encoding'] = output.ContentEncoding
        if (output.ContentLanguage)
          headers['content-language'] = output.ContentLanguage
        if (output.ContentLength)
          headers['content-length'] = `${output.ContentLength}`
        if (output.ContentRange) headers['content-range'] = output.ContentRange
        if (output.ContentType) headers['content-type'] = output.ContentType
        if (output.ETag) headers['etag'] = output.ETag
        res.set(headers)

        const stream = output.Body as Readable
        stream.pipe(res)
      } catch (err) {
        res.status(404)
        next(err)
      }
    }
  }

  async read(options: ReadOptions = { path: '' }) {
    let path = (options.path || '').replace(/\/$|\\$/, '')

    // check if path is stored in s3 handled by us
    if (!path.startsWith(this.host)) {
      throw new Error(`${path} is not stored in s3`)
    }
    path = path.substring(this.host.length)

    const response = await this.s3().getObject({
      Bucket: this.bucket,
      Key: stripLeadingSlash(normalizePath(path)),
    })
    const stream = response.Body as Readable

    return await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = []
      stream.on('data', (chunk) => chunks.push(chunk))
      stream.once('end', () => resolve(Buffer.concat(chunks)))
      stream.once('error', reject)
    })
  }
}

export default S3Storage
