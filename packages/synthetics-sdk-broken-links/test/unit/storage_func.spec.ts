// Copyright 2023 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      https://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { expect } from 'chai';
import sinon from 'sinon';
import { Storage, Bucket, File } from '@google-cloud/storage';
import puppeteer, { Browser, HTTPResponse, Page } from 'puppeteer';

import * as sdkApi from '@google-cloud/synthetics-sdk-api';
import {
  createStorageClientIfStorageSelected,
  getFolderNameFromStorageLocation,
  getOrCreateStorageBucket,
  StorageParameters,
  uploadScreenshotToGCS,
} from '../../src/storage_func';
const proxyquire = require('proxyquire');

// global test vars
const TEST_BUCKET_NAME = 'gcm-test-project-id-synthetics-test-region';

describe('GCM Synthetics Broken Links storage_func suite testing', () => {
  let storageClientStub: sinon.SinonStubbedInstance<Storage>;
  let bucketStub: sinon.SinonStubbedInstance<Bucket>;

  const storageFunc = proxyquire('../../src/storage_func', {
    '@google-cloud/synthetics-sdk-api': {
      getExecutionRegion: () => 'test-region',
      resolveProjectId: () => 'test-project-id',
    },
  });

  const storage_condition_failing_links =
    sdkApi
      .BrokenLinksResultV1_BrokenLinkCheckerOptions_ScreenshotOptions_CaptureCondition
      .FAILING;
  const storage_condition_none =
    sdkApi
      .BrokenLinksResultV1_BrokenLinkCheckerOptions_ScreenshotOptions_CaptureCondition
      .NONE;

  beforeEach(() => {
    // Stub a storage bucket
    bucketStub = sinon.createStubInstance(Bucket);
    bucketStub.name = TEST_BUCKET_NAME;
    bucketStub.create.resolves([bucketStub]);

    // Stub the storage client
    storageClientStub = sinon.createStubInstance(Storage);
    storageClientStub.bucket.returns(bucketStub);
  });

  afterEach(() => {
    sinon.restore();
  });

  describe.only('getOrCreateStorageBucket()', () => {
    it('should create a bucket if no storage_location is provided', async () => {
      bucketStub.exists.resolves([false]); // Simulate the bucket not existing initially

      const result = await storageFunc.getOrCreateStorageBucket(
        storageClientStub,
        '',
        []
      );
      expect(result).to.equal(bucketStub);
      expect(result.name).to.equal(TEST_BUCKET_NAME);
    });

    it('should return null if projectId or region cannot be resolved', async () => {
      const failingProjectId = proxyquire('../../src/storage_func', {
        '@google-cloud/synthetics-sdk-api': {
          getExecutionRegion: () => 'test-region',
          resolveProjectId: () => '',
        },
      });

      const result = await failingProjectId.getOrCreateStorageBucket(
        storageClientStub,
        '',
        []
      );
      expect(result).to.be.null;
    });

    it('should return existing synthetics bucket if found when storage_location is not provided ', async () => {
      bucketStub.exists.resolves([true]); // Simulate the bucket already exists

      const result = await storageFunc.getOrCreateStorageBucket(
        storageClientStub,
        TEST_BUCKET_NAME + '/fake-folder',
        []
      );
      expect(result).to.equal(bucketStub);
      sinon.assert.calledWithExactly(
        storageClientStub.bucket,
        TEST_BUCKET_NAME
      );
      sinon.assert.notCalled(bucketStub.create);
    });

    it('should handle errors during bucket.exists()', async () => {
      bucketStub.exists.throws(new Error('Simulated exists() error'));

      const errors: sdkApi.BaseError[] = [];
      const result = await storageFunc.getOrCreateStorageBucket(
        storageClientStub,
        'user-bucket',
        errors
      );

      expect(result).to.be.null;
      expect(errors.length).to.equal(1);
      expect(errors[0].error_type).to.equal('StorageValidationError');
    });

    it('should handle errors during bucket creation', async () => {
      bucketStub.create.throws(new Error('Simulated creation error')); // Force an error

      const errors: sdkApi.BaseError[] = [];
      const result = await storageFunc.getOrCreateStorageBucket(
        storageClientStub,
        '',
        errors
      );

      expect(result).to.be.null;
      expect(errors.length).to.equal(1);
      expect(errors[0].error_type).to.equal('BucketCreationError');
    });
  });

  describe('createStorageClient()', () => {
    it('should return null if storage_condition is `None`', () => {
      const result = createStorageClientIfStorageSelected(
        [],
        storage_condition_none
      );
      expect(result).to.be.null;
    });
    it('should successfully initialize a Storage client', () => {
      const result = createStorageClientIfStorageSelected(
        [],
        storage_condition_failing_links
      );
      expect(result).to.be.an.instanceOf(Storage);
    });
  });

  describe('uploadScreenshotToGCS', () => {
    let storageClientStub: sinon.SinonStubbedInstance<Storage>;
    let bucketStub: sinon.SinonStubbedInstance<Bucket>;
    let pageStub : sinon.SinonStubbedInstance<Page>;

    beforeEach(() => {
      storageClientStub = sinon.createStubInstance(Storage);
      bucketStub = sinon.createStubInstance(Bucket);
      pageStub = sinon.createStubInstance(Page);
      pageStub.url.resolves('https://fake-url');

      storageClientStub.bucket.returns(bucketStub);
    });

    afterEach(() => {
      sinon.restore();
    });

    describe('valid Storage Configuration', () => {
    it('should upload the screenshot and return the write_destination', async () => {
      const storageParams = {
        storageClient: storageClientStub,
        bucket: bucketStub,
        uptimeId: 'uptime123',
        executionId: 'exec456',
      };
      const options = {
        screenshot_options: { storage_location: 'bucket/folder1/folder2' },
      } as sdkApi.BrokenLinksResultV1_BrokenLinkCheckerOptions;
      const expectedWriteDestination =
        'folder1/folder2/uptime123/exec456/test-file-name.png';

      const successPartialFileMock: Partial<File> = {
        save: sinon.stub().resolves(),
      };
      bucketStub.file.returns(successPartialFileMock as File);

      const result = await uploadScreenshotToGCS(
        pageStub,
        storageParams,
        options
      );

      expect(result.screenshot_file).to.equal(expectedWriteDestination);
      expect(result.screenshot_error).to.deep.equal({});
    });

    it('should handle GCS upload errors', async () => {
      const storageParams: StorageParameters = {
        storageClient: storageClientStub,
        bucket: bucketStub,
        uptimeId: '',
        executionId: '',
      };
      const options = {
        screenshot_options: {},
      } as sdkApi.BrokenLinksResultV1_BrokenLinkCheckerOptions;

      const gcsError = new Error('Simulated GCS upload error');
      const failingPartialFileMock: Partial<File> = {
        save: sinon.stub().throws(gcsError),
      };
      bucketStub.file.returns(failingPartialFileMock as File);

      const result = await uploadScreenshotToGCS(
        pageStub,
        storageParams,
        options
      );

      expect(result.screenshot_file).to.equal('');
      expect(result.screenshot_error).to.deep.equal({
        error_type: 'ScreenshotFileUploadError',
        error_message: 'Failed to take and/or upload screenshot for https://fake-url. Please reference server logs for further information.',
      });
    });
  });

    describe('Invalid Storage Configuration', () => {
      const emptyOptions = {} as sdkApi.BrokenLinksResultV1_BrokenLinkCheckerOptions;

      beforeEach(() => {
        pageStub.screenshot.resolves(Buffer.from('encoded-image-data', "utf-8"));
      })

      it('should return an empty result if storageClient is null', async () => {
        // Missing storageClient
        const storageParams = {
          storageClient: null,
          bucket: bucketStub,
          uptimeId: '',
          executionId: '',
        };

        const result = await uploadScreenshotToGCS(
          pageStub,
          storageParams,
          emptyOptions
        );

        expect(result).to.deep.equal({
          screenshot_file: '',
          screenshot_error: {},
        });
      });

      it('should return an empty result if bucket is null', async () => {
        // Missing bucket
        const storageParams = {
          storageClient: storageClientStub,
          bucket: null,
          uptimeId: '',
          executionId: '',
        };

        const result = await uploadScreenshotToGCS(
          pageStub,
          storageParams,
          emptyOptions
        );

        expect(result).to.deep.equal({
          screenshot_file: '',
          screenshot_error: {},
        });
      });
    });
  });

  describe('getFolderNameFromStorageLocation', () => {
    it('should extract folder name when storage location has a slash', () => {
      const storageLocation = 'some-bucket/folder1/folder2';
      const expectedFolderName = 'folder1/folder2';

      const result = getFolderNameFromStorageLocation(storageLocation);
      expect(result).to.equal(expectedFolderName);
    });

    it('should return an empty string if storage location has no slash', () => {
      const storageLocation = 'my-bucket';
      const expectedFolderName = '';

      const result = getFolderNameFromStorageLocation(storageLocation);
      expect(result).to.equal(expectedFolderName);
    });

    it('should return an empty string if given an empty string', () => {
      const storageLocation = '';
      const expectedFolderName = '';

      const result = getFolderNameFromStorageLocation(storageLocation);
      expect(result).to.equal(expectedFolderName);
    });
  });
});
