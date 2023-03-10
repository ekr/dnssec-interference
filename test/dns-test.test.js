/* eslint-env node, mocha */
/* global browser */


/**
 * @typedef {import("../src/dns-test.js").QueryConfig} QueryConfig
 */

const { default: browserMock } = require("webextensions-api-mock");
const {
    main,
    resetState,
    computeKey,
    computeDomain,
    sendDNSQuery,
    TELEMETRY_TYPE,
    STUDY_START,
    STUDY_MEASUREMENT_COMPLETED,
    COMMON_QUERIES,
    EXPECTED_FETCH_RESPONSE,
    SMIMEA_HASH,
    APEX_DOMAIN_NAME,
    FETCH_ENDPOINT
} = require("../src/dns-test");
const chai = require("chai")
const { assert } = chai;
const sinon = require("sinon");
const { v4: uuidv4 } = require("uuid");

// Validate according to the data pipeline schema
// https://github.com/mozilla-services/mozilla-pipeline-schemas/blob/main/schemas/telemetry/dnssec-study-v1/dnssec-study-v1.4.schema.json
const Ajv = require("ajv");
const ajv = new Ajv();
const pingSchema = require("./dnssec-v1.schema.json");
const payloadSchema = {
    definitions: pingSchema.definitions,
    properties: {
        payload: pingSchema.properties.payload
    }
};

function validatePayload(payload) {
    const validate = ajv.compile(payloadSchema);
    const valid = validate({payload});
    assert.isOk(valid, "not a valid payload:\n" + JSON.stringify(validate.errors, null, 2));
}

// < Node 18
global.fetch = global.fetch || require("node-fetch");

/**
 * Some fake configuration
 */
const FAKE_NAMESERVERS = ["172.19.134.11", "172.19.134.12"];
const FAKE_WEBEXT_RESP = ["34.120.4.181"];
const FAKE_DNSQUERY_RESP = [1, 2, 3];
const FAKE_UUID = uuidv4();
/**
 * This is a list of all key types we expect to see in the final ping.
 * Each item will have 4 variants: tcp, udp, tcp per-client, udp per-client
 */
const ALL_KEY_TYPES = [
    "webext-A",
    "webext-A-U",
    "udp-NEWONE",
    "udp-NEWONE-U",
    "udp-NEWONE-prefix",
    "udp-NEWONE-alt",
    "udp-NEWONE-alt-U",
    "udp-NEWONE-alt-prefix",
    "webext-A-prefix",
    "udp-NEWONE-afirst"
];

/**
 * A non-exhaustive list of queries/domains to check to mak sure we're computing
 * and sending the expected key and domain structure.
 */
const EXPECTED_QUERY_CHECK = [
    // A few A records with various flags
    ["tcp", "tcp-A", APEX_DOMAIN_NAME],
    ["udp", "udp-A", APEX_DOMAIN_NAME],
    ["tcp", "tcp-ADO", APEX_DOMAIN_NAME],
    ["udp", "udp-ADOCD", APEX_DOMAIN_NAME],
    ["tcp", "tcp-A-N-U", `tcp-A-N-U-${FAKE_UUID}.pc.${APEX_DOMAIN_NAME}`],

    // HTTPS records should have a prefix
    ["tcp", "tcp-HTTPS", "httpssvc." + APEX_DOMAIN_NAME],
    ["tcp", "tcp-HTTPS-U", `tcp-HTTPS-U-${FAKE_UUID}.httpssvc-pc.${APEX_DOMAIN_NAME}`],
    ["udp", "udp-HTTPS", "httpssvc." + APEX_DOMAIN_NAME],
    ["udp", "udp-HTTPS-U", `udp-HTTPS-U-${FAKE_UUID}.httpssvc-pc.${APEX_DOMAIN_NAME}`],

    // SMIMEA records should have the right SMIMEA structure
    ["tcp", "tcp-SMIMEA", SMIMEA_HASH + "._smimecert." + APEX_DOMAIN_NAME],
    ["udp", "udp-SMIMEA-U", `udp-SMIMEA-U-${FAKE_UUID}._smimecert.pc.${APEX_DOMAIN_NAME}`],
];

function mockFetch(url, text) {
    global.fetch.withArgs(url).resolves(Promise.resolve({text: () => Promise.resolve(text)}));
}

/**
 *  It's difficult to import the privileged APIs for the add-on directly,
 *  so we just stub them out.
 */
function setupExperiments(browserObj) {
    const { sinonSandbox } = browserObj;
    browserObj.experiments = {
        resolvconf: {
            readNameserversMac: sinonSandbox.stub(),
            readNameserversWin: sinonSandbox.stub()
        },
        tcpsocket: {
            sendDNSQuery: sinonSandbox.stub()
        },
        udpsocket: {
            sendDNSQuery: sinonSandbox.stub()
        }
    };
}

/**
 * This simulates an environment in which DNS queries can be properly sent
 * and a response is returned.
 */
async function setupMeasurementEnvironment(sandbox) {
    browser.telemetry.canUpload.resolves(true);
    browser.captivePortal.getState.resolves("not_captive");
    browser.runtime.getPlatformInfo.resolves({os: "win"});
    browser.runtime.getManifest.returns({version: "1.2.3"})


    mockFetch(FETCH_ENDPOINT, EXPECTED_FETCH_RESPONSE);

    browser.experiments.resolvconf.readNameserversWin.resolves(FAKE_NAMESERVERS);
    browser.dns.resolve.resolves({addresses: FAKE_WEBEXT_RESP})
    browser.experiments.tcpsocket.sendDNSQuery.resolves(Buffer.from(FAKE_DNSQUERY_RESP));
    browser.experiments.udpsocket.sendDNSQuery.resolves(Buffer.from(FAKE_DNSQUERY_RESP));
}

/**
 * @callback customPingMatch
 * @param {{[key: string]: any}} payload The payload sent with the ping
 * @returns {boolean} True if the payload is valid, or else false
 */

/**
 * A helper test function to test whether a telemetry ping was sent with the
 * right parameters.
 *
 * @param {string} reason The reason field included in the ping, e.g. "STUDY_START"
 * @param {customPingMatch=} customMatch Optional function to check other properties in the ping
 */
function assertPingSent(reason, customMatch) {
    sinon.assert.calledWithMatch(
        global.browser.telemetry.submitPing,
        TELEMETRY_TYPE,
        sinon.match((payload => {
            if (payload.reason === reason) {
                if (customMatch) {
                    validatePayload(payload);
                    return customMatch(payload);
                }
                return true;
            }
            return false;
        }))
    );
}

function run(opts = {}) {
    return main({ uuid: FAKE_UUID, sleep: 0, ...opts });
}

describe("dns-test.js", () => {
    before(async function () {
        global.browser = browserMock();
        setupExperiments(global.browser);
        global.browser.sinonSandbox.stub(global, "fetch");
        global.browser.sinonSandbox.spy(sendDNSQuery);
    });

    after(() => {
        delete global.browser;
    });

    beforeEach(async () => {
        browser.sinonSandbox.resetHistory();
        resetState();
        setupMeasurementEnvironment();
    });

    describe("computeKey", () => {
        it("should compute a key for a record", () => {
            assert.equal(computeKey("tcp", {rrtype: "A"}), "tcp-A");
        });
        it("should compute a key for a per-client record", () => {
            assert.equal(computeKey("tcp", {rrtype: "A"}, true), "tcp-A-U");
        });
        it("should compute a key for a DO record", () => {
            assert.equal(computeKey("udp", {rrtype: "A", dnssec_ok: true}), "udp-ADO");
        });
        it("should compute a key for a CD record", () => {
            assert.equal(computeKey("udp", {rrtype: "A", checking_disabled: true}), "udp-ACD");
        });
        it("should compute a key for a noedns0 + per-client record", () => {
            assert.equal(computeKey("udp", {rrtype: "A", noedns0: true}, true), "udp-A-N-U");
        });
    });

    describe("computeDomain", async () => {
        await run({uuid: "foo"});

        it("should compute a non-per-client domain", () => {
            assert.equal(computeDomain("tcp-A", {rrtype: "A"}, false), APEX_DOMAIN_NAME);
        });
        it("should add a prefix for a non-per-client domain", () => {
            assert.equal(computeDomain("udp-HTTPS-U", {rrtype: "HTTPS", prefix: "httpssvc"}, false), "httpssvc." + APEX_DOMAIN_NAME);
        });
        it("should compute a per-client domain", () => {
            assert.equal(computeDomain("udp-A-U", {rrtype: "A", }, true), `udp-A-U-foo.pc.` + APEX_DOMAIN_NAME);
        });
        it("should compute a per-client domain with custom prefix", () => {
            assert.equal(computeDomain("udp-HTTPS-U", {rrtype: "HTTPS", perClientPrefix: "httpssvc-pc."}, true), `udp-A-U-foo.httpssvc-pc.` + APEX_DOMAIN_NAME);
        });
    });

    describe("pings", () => {
        it("should send a STUDY_START ping", async () => {
            await run();
            assertPingSent(STUDY_START);
        });

        // TODO - we changed the number of keys for a specific sub-experiment
        it.skip("should send a valid STUDY_MEASUREMENT_COMPLETED ping with the right number of keys", async () => {
            await run();
            /**
             * The total number of expected entries 4 queries for each item in the COMMON_QUERY config,
             * and 2 extra (for the webext-A and webext-A-U queries)
             */
            assertPingSent(STUDY_MEASUREMENT_COMPLETED, ({
                dnsData,
                dnsAttempts,
            }) => {
                assert.lengthOf(Object.keys(dnsData),  2 + COMMON_QUERIES.length * 4);
                assert.lengthOf(Object.keys(dnsAttempts),  2 + COMMON_QUERIES.length * 4);
                return true;
            });
        });

        it("should send a STUDY_MEASUREMENT_COMPLETED ping with the right data", async () => {
            await run();
            const expected = {
                reason: STUDY_MEASUREMENT_COMPLETED,
                measurementID: FAKE_UUID,
                dnsAttempts: {},
                dnsData: {},
                dnsQueryErrors: [],
                dnsQueryInfo: {},
                hasErrors: false,
                addonVersion: "1.2.3",
                apexDomain: APEX_DOMAIN_NAME
            };

            ALL_KEY_TYPES.forEach(key => {
                expected.dnsAttempts[key] = 1;
                expected.dnsData[key] = key.match(/^webext/) ? FAKE_WEBEXT_RESP : FAKE_DNSQUERY_RESP;
            });

            assertPingSent(STUDY_MEASUREMENT_COMPLETED, (payload) => {
                // Check this separately
                const { dnsQueryInfo } = payload;
                payload.dnsQueryInfo = {}
                assert.deepEqual(
                    payload,
                    expected,
                    "should have all the expected data"
                );
                assert.deepEqual(Object.keys(dnsQueryInfo).sort(), ALL_KEY_TYPES.sort());
                return true;
            });
        });
        it("should send a STUDY_MEASUREMENT_COMPLETED ping with the correct data when udp reattempts were made", async () => {
            const expectedAttempts = {};
            const expectedData = {};

            // Ensure udpsocket fails only for the first nameserver
            browser.experiments.udpsocket.sendDNSQuery.withArgs(FAKE_NAMESERVERS[0]).throws();

            await run();

            ALL_KEY_TYPES.forEach(key => {
                expectedAttempts[key] = key.match(/^udp/) ? 2 : 1
                expectedData[key] = key.match(/^webext/) ? FAKE_WEBEXT_RESP : FAKE_DNSQUERY_RESP;
            });

            assertPingSent(STUDY_MEASUREMENT_COMPLETED, ({dnsAttempts, dnsData, dnsQueryErrors}) => {
                assert.deepEqual(
                    dnsAttempts,
                    expectedAttempts,
                    "dnsAttempts should exist and have 1 attempt"
                );
                assert.includeDeepMembers(
                    dnsQueryErrors,
                    [
                        {
                            reason: 'STUDY_ERROR_UDP_MISC',
                            errorRRTYPE: 'udp-NEWONE-U',
                            errorAttempt: 1
                        },
                        {
                            reason: 'STUDY_ERROR_UDP_MISC',
                            errorRRTYPE: 'udp-NEWONE-U',
                            errorAttempt: 1
                      }
                    ],
                    "errors were logged"
                );
                assert.deepEqual(
                    dnsData,
                    expectedData,
                    "dnsData should exist and have the right response"
                );
                return true;
            });
        });

        it("should send STUDY_MEASUREMENT_COMPLETED even when some queries fail", async () => {
            browser.experiments.udpsocket.sendDNSQuery.withArgs(APEX_DOMAIN_NAME).throws();
            browser.experiments.tcpsocket.sendDNSQuery.withArgs(APEX_DOMAIN_NAME).throws();

            await run();


            assertPingSent(STUDY_MEASUREMENT_COMPLETED);
        });
    });

    describe.skip("queries", () => {
        it("should send two control queries, one basic and one to the per-client domain", async () => {
            await run();
            sinon.assert.calledTwice(sendDNSQuery.webext);
            sinon.assert.calledWithMatch(sendDNSQuery.webext, "webext-A", APEX_DOMAIN_NAME);
            sinon.assert.calledWithMatch(sendDNSQuery.webext, "webext-A-U", "webext-A-U-" + FAKE_UUID + ".pc." + APEX_DOMAIN_NAME);
        });

        it("should send the expected tcp and udp queries", async () => {
            await run();
            EXPECTED_QUERY_CHECK.forEach(([transport, ...args]) => {
                sinon.assert.calledWithMatch(sendDNSQuery[transport], ...args);
            });
        });
    });
});
