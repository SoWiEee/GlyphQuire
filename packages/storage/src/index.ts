export interface StoragePort {
  upload(
    key: string,
    data: Buffer | ReadableStream,
    contentType: string,
  ): Promise<StorageResult>;
  download(key: string): Promise<StorageObject>;
  delete(key: string): Promise<void>;
  getSignedUrl(key: string, expiresIn: number): Promise<string>;
}

export interface StorageResult {
  key: string;
  size: number;
  contentType: string;
}

export interface StorageObject {
  data: ReadableStream;
  contentType: string;
  size: number;
}
