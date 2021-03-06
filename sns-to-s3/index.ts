import AWS from "aws-sdk";
import "isomorphic-fetch"; // required for 'dropbox' module
import { Dropbox } from "dropbox";

const s3 = new AWS.S3();
const dynamoDB = new AWS.DynamoDB({ apiVersion: "2012-10-08" });

type SNSMessage = {
  Sns: {
    TopicArn: string;
    Message: string;
    MessageAttributes?: {
      [key: string]: {
        Type: "String" | "Binary";
        Value: string;
      };
    };
    Subject?: string;
  };
};
type SNSEvent = {
  Records: SNSMessage[];
};
type Omit<T, K extends keyof T> = Pick<T, Exclude<keyof T, K>>;

export const handler = async (event: SNSEvent) => {
  // Verify environment
  const {
    DROPBOX_USER_ID,
    DROPBOX_USER_TOKEN,
    AWS_SNS_TOPIC_ARN,
    AWS_S3_BUCKET_NAME,
    AWS_DYNAMODB_TABLE_NAME
  } = process.env;
  if (
    !DROPBOX_USER_ID ||
    !DROPBOX_USER_TOKEN ||
    !AWS_SNS_TOPIC_ARN ||
    !AWS_S3_BUCKET_NAME ||
    !AWS_DYNAMODB_TABLE_NAME
  ) {
    throw new Error("Missing environment variable");
  }

  // Verify SNS Topic ARN
  const topicArn = event.Records[0].Sns.TopicArn;
  if (topicArn !== AWS_SNS_TOPIC_ARN) {
    throw new Error("Invalid SNS Topic ARN");
  }

  // Create Dropbox service
  const dropbox = new Dropbox({ accessToken: DROPBOX_USER_TOKEN });

  try {
    // Get cursor from DynamoDB
    const { Item: dynamoItem } = await dynamoDB
      .getItem({
        TableName: AWS_DYNAMODB_TABLE_NAME,
        Key: {
          id: { S: DROPBOX_USER_ID }
        },
        ProjectionExpression: "dropboxCursor"
      })
      .promise();
    const previousCursor =
      (dynamoItem && dynamoItem.dropboxCursor && dynamoItem.dropboxCursor.S) ||
      null;

    // Get files from Dropbox
    let cursor: DropboxTypes.files.ListFolderCursor | null = previousCursor;
    let hasMore = true;

    // Call /files/list_folder for the given user ID and process any changes
    while (hasMore) {
      console.log("Continuing to list files");
      const listFolderResult = await (() => {
        if (!cursor) {
          console.log("No Dropbox cursor available");
          return dropbox.filesListFolder({ path: "", recursive: true });
        } else {
          console.log(`Continuing from Dropbox cursor '${cursor}'`);
          return dropbox.filesListFolderContinue({ cursor });
        }
      })();

      console.log(
        `Received response from Dropbox API: '${JSON.stringify(
          listFolderResult
        )}'`
      );
      for (const _entry of listFolderResult.entries) {
        const entry: Omit<typeof _entry, "path_lower"> & {
          path_lower?: string;
        } = _entry;
        // Ignore folders, and non-markdown files
        if (
          entry[".tag"] === "folder" ||
          !entry.path_lower ||
          !entry.path_lower.endsWith(".md")
        ) {
          console.log(
            `Skipping folder or non-markdown file '${entry.path_lower}'`
          );
          continue;
        }
        if (entry[".tag"] === "deleted") {
          // Delete file from S3
          console.log(`Deleting file '${entry.path_lower}' from S3`);
          await s3
            .deleteObject({
              Bucket: AWS_S3_BUCKET_NAME,
              Key: entry.path_lower.replace(/^\//, "")
            })
            .promise();
          continue;
        }
        // Download file metadata
        const file: DropboxTypes.files.FileMetadata & {
          fileBinary?: Buffer;
        } = await dropbox.filesDownload({ path: entry.path_lower });
        // Verify file metatdata
        if (!file.path_lower || !file.fileBinary) {
          console.log("Skipping file with invalid metadata");
          continue;
        }
        // Upload file to S3
        console.log(`Uploading file '${file.path_lower}' to S3`);
        await s3
          .putObject({
            Bucket: AWS_S3_BUCKET_NAME,
            Key: file.path_lower.replace(/^\//, ""),
            Body: file.fileBinary
          })
          .promise();
        continue;
      }
      // Update cursor
      cursor = listFolderResult.cursor;
      // Repeat only if there's more to do
      hasMore = listFolderResult.has_more;
    }

    // Update cursor in DynamoDB
    if (cursor) {
      console.log(`Storing cursor '${cursor}' in DynamoDB`);
      await dynamoDB
        .putItem({
          TableName: AWS_DYNAMODB_TABLE_NAME,
          Item: {
            id: { S: DROPBOX_USER_ID },
            dropboxCursor: { S: cursor }
          }
        })
        .promise();
    }
  } catch (error) {
    throw error;
  }

  // Exit
  return {
    statusCode: 200,
    body: "File retrieved"
  };
};
