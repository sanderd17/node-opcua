"use strict";
/**
 * @module opcua.miscellaneous
 */

const util = require("util");
const assert = require("node-opcua-assert").assert;
const _ = require("underscore");
const EventEmitter = require("events").EventEmitter;

const ChunkManager = require("node-opcua-chunkmanager").ChunkManager;
const BinaryStream = require("node-opcua-binary-stream").BinaryStream;

const AsymmetricAlgorithmSecurityHeader = require("node-opcua-service-secure-channel")
    .AsymmetricAlgorithmSecurityHeader;
const SymmetricAlgorithmSecurityHeader = require("node-opcua-service-secure-channel").SymmetricAlgorithmSecurityHeader;
const SequenceHeader = require("node-opcua-service-secure-channel").SequenceHeader;

function chooseSecurityHeader(msgType) {
    const securityHeader =
        msgType === "OPN" ? new AsymmetricAlgorithmSecurityHeader() : new SymmetricAlgorithmSecurityHeader();
    return securityHeader;
}

exports.chooseSecurityHeader = chooseSecurityHeader;

/**
 * @class SecureMessageChunkManager
 *
 * @param msgType
 * @param options
 * @param options.chunkSize {Integer} [=8192]
 * @param options.secureChannelId
 * @param options.requestId
 * @param options.signatureLength  {number}  [undefined]
 * @param options.signingFunc {Function} [undefined]
 *
 * @param securityHeader
 * @param sequenceNumberGenerator
 * @constructor
 */
const SecureMessageChunkManager = function(msgType, options, securityHeader, sequenceNumberGenerator) {
    const self = this;
    self.aborted = false;

    msgType = msgType || "OPN";

    securityHeader = securityHeader || chooseSecurityHeader(msgType);
    assert(_.isObject(securityHeader));

    // the maximum size of a message chunk:
    // Note: OPCUA requires that chunkSize is at least 8192
    self.chunkSize = options.chunkSize || 1024 * 128;

    self.msgType = msgType;

    options.secureChannelId = options.secureChannelId || 0;
    assert(_.isFinite(options.secureChannelId));
    self.secureChannelId = options.secureChannelId;

    const requestId = options.requestId;

    self.sequenceNumberGenerator = sequenceNumberGenerator;

    self.securityHeader = securityHeader;

    assert(requestId > 0, "expecting a valid request ID");

    self.sequenceHeader = new SequenceHeader({ requestId: requestId, sequenceNumber: -1 });

    const securityHeaderSize = self.securityHeader.binaryStoreSize();
    const sequenceHeaderSize = self.sequenceHeader.binaryStoreSize();
    assert(sequenceHeaderSize === 8);

    self.headerSize = 12 + securityHeaderSize;

    const params = {
        chunkSize: self.chunkSize,

        headerSize: self.headerSize,
        writeHeaderFunc: function(block, isLast, totalLength) {
            let finalC = isLast ? "F" : "C";
            finalC = this.aborted ? "A" : finalC;
            self.write_header(finalC, block, totalLength);
        },

        sequenceHeaderSize: options.sequenceHeaderSize,
        writeSequenceHeaderFunc: function(block) {
            assert(block.length === this.sequenceHeaderSize);
            self.writeSequenceHeader(block);
        },

        // ---------------------------------------- Signing stuff
        signatureLength: options.signatureLength,
        compute_signature: options.signingFunc,

        // ---------------------------------------- Encrypting stuff
        plainBlockSize: options.plainBlockSize,
        cipherBlockSize: options.cipherBlockSize,
        encrypt_buffer: options.encrypt_buffer
    };

    self.chunkManager = new ChunkManager(params);

    self.chunkManager.on("chunk", function(chunk, is_last) {
        /**
         * @event chunk
         * @param chunk {Buffer}
         */
        self.emit("chunk", chunk, is_last || self.aborted);
    });
};
util.inherits(SecureMessageChunkManager, EventEmitter);

SecureMessageChunkManager.prototype.write_header = function(finalC, buf, length) {
    assert(buf.length > 12);
    assert(finalC.length === 1);
    assert(buf instanceof Buffer);

    const bs = new BinaryStream(buf);

    // message header --------------------------
    const self = this;
    // ---------------------------------------------------------------
    // OPC UA Secure Conversation Message Header : Part 6 page 36
    // MessageType     Byte[3]
    // IsFinal         Byte[1]  C : intermediate, F: Final , A: Final with Error
    // MessageSize     UInt32   The length of the MessageChunk, in bytes. This value includes size of the message header.
    // SecureChannelId UInt32   A unique identifier for the ClientSecureChannelLayer assigned by the server.

    bs.writeUInt8(self.msgType.charCodeAt(0));
    bs.writeUInt8(self.msgType.charCodeAt(1));
    bs.writeUInt8(self.msgType.charCodeAt(2));
    bs.writeUInt8(finalC.charCodeAt(0));

    bs.writeUInt32(length);
    bs.writeUInt32(self.secureChannelId);

    assert(bs.length === 12);

    //xx console.log("securityHeader size = ",this.securityHeader.binaryStoreSize());
    // write Security Header -----------------
    this.securityHeader.encode(bs);
    assert(bs.length === this.headerSize);
};

SecureMessageChunkManager.prototype.writeSequenceHeader = function(block) {
    const bs = new BinaryStream(block);
    // write Sequence Header -----------------
    this.sequenceHeader.sequenceNumber = this.sequenceNumberGenerator.next();
    this.sequenceHeader.encode(bs);
    assert(bs.length === 8);
};

/**
 * @method write
 * @param buffer {Buffer}
 * @param length {Integer} - optional if not provided  buffer.length is used instead.
 */
SecureMessageChunkManager.prototype.write = function(buffer, length) {
    length = length || buffer.length;
    this.chunkManager.write(buffer, length);
};

/**
 * @method abort
 *
 */
SecureMessageChunkManager.prototype.abort = function() {
    this.aborted = true;
    this.end();
};

/**
 * @method end
 */
SecureMessageChunkManager.prototype.end = function() {
    this.chunkManager.end();
    this.emit("finished");
};

exports.SecureMessageChunkManager = SecureMessageChunkManager;
