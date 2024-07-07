import S3Storage from '../src/index'; // Adjust the import path according to your project structure
import * as fs from 'fs';
import * as path from 'path';
import { type Image } from 'ghost-storage-base'

describe('S3Storage', () => {
  let s3Storage: S3Storage;

  beforeAll(() => {
    // Initialize S3Storage with your test configuration
    s3Storage = new S3Storage({
      accessKeyId: process.env.AWS_ACCESS_KEY_ID, // Ensure these are set in your environment or AWS credentials file
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      region: process.env.REGION, // Replace with your AWS region
      bucket: process.env.BUCKET, // Replace with your test bucket name
      acl: 'public-read', // Example ACL, adjust as needed
    });
  });

  afterAll(async () => {
    // Cleanup: Consider deleting the uploaded file after testing if necessary
  });

  it('should save an image to S3', async () => {
    // Create a test image file or use an existing one
    const imageName = 'test-image_o.png'; // Adjust the image name
    const testImagePath = path.join(__dirname, 'test-image_o.png'); // Adjust the path to your test image
    const image: Image = {
      path: testImagePath,
      name: imageName,
      type: 'image/png',
    };

    // Call the save function
    const resultUrl = await s3Storage.save(image);

    // Verify the result
    expect(resultUrl).toBeDefined();
    expect(resultUrl).toContain('https://your-test-bucket.s3.your-region.amazonaws.com/'); // Adjust the expected URL format based on your configuration

    // Additional verification can include checking the file exists in S3, which would require using the AWS SDK to list objects in the bucket or get the specific object.
  });
});