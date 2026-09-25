// First, before anything that can read the config directory.
import { assertIsolatedConfigDir } from '../../../scripts/test-env.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { BrightwheelClient, startMockBrightwheel, Secret, verify, formatReport } from '../dist/index.js';
import { isWithheld, parseWithheld } from '../dist/api/withheld.js';

/**
 * A child's check-in and pickup code arrives beside every photo: Brightwheel embeds the child
 * in each activity record as `target`, passcode, invite code and phone numbers included, and
 * `/users/me` carries the parent's own. The tool cannot ask for the photos without being sent
 * them, so it drops them as each answer is parsed (src/api/withheld.ts), and nothing after
 * that — parser, log, error, report or file — can reach them. The mock sends them in both
 * places, as the live service does.
 */

before(assertIsolatedConfigDir);

const SESSION = 'test-session-value';
let mock;
before(async () => { mock = await startMockBrightwheel({ validSession: SESSION, activitiesPerStudent: 3, leadingCheckIns: 2 }); });
after(async () => { await mock?.close(); });

/** The mock's codes and numbers. '4821' is the passcode, on the parent and on every child. */
const VALUES = ['4821', 'INVITE-NEVER-STORE', '+15550000000', '+15550000001'];
const NAMES = ['raw_passcode', 'invite_code', 'phone_1', 'phone_2', 'auth_phone_number'];

function assertNoneOf(text, where) {
  for (const secret of [...VALUES, ...NAMES]) assert.ok(!text.includes(secret), `${where} still holds "${secret}"`);
}

test('check-in, pickup and invite codes, PINs, passwords, tokens and phone numbers are withheld, by the words in their names', () => {
  for (const name of [
    'raw_passcode', 'passcode', 'invite_code', 'checkin_code', 'check_in_code', 'checkInCode', 'checkoutCode',
    'check_out_code', 'pickup_code', 'pickupPin', 'PIN', 'pin', 'pins', 'pin_number', 'kioskPasscode', 'kiosk-code',
    'access_code', 'barcode', 'qr_code', 'password', 'passphrase', 'access_token', 'secret',
    'auth_phone_number', 'phone', 'phone_1', 'phone_2', 'phone1', 'phoneNumber', 'mobile', 'sms_number',
    // A number on the end, which Brightwheel already uses (phone_1, phone_2).
    'pin1', 'PIN2', 'code1', 'passcode1', 'raw_passcode2', 'checkinCode2', 'pickupPin2', 'kioskPIN2',
    // Names that say it in two words, or in other words.
    'security_word', 'safe_word', 'pickup_word', 'pickupWord', 'passkey', 'pass_key', 'otp', 'pw', 'pwd',
    'checkin_number', 'check_in_number', 'pickup_key', 'access_key', 'safe_phrase',
  ]) {
    assert.equal(isWithheld(name), true, name);
  }
});

test('nothing the tool reads is withheld', () => {
  // Every field name the parsers and the envelope reader take (src/api/schema.ts, client.ts),
  // and verify's own list. If one of these were ever withheld, a run would lose it silently.
  for (const name of [
    'object_id', 'id', 'first_name', 'last_name', 'name', 'email', 'user_type', 'student', 'students', 'school',
    'relationship_type', 'data', 'object', 'activities', 'action_type', 'actor', 'role', 'media', 'image_url',
    'media_url', 'video_info', 'downloadable_url', 'url', 'video_url', 'note', 'description', 'event_date',
    'event_time', 'created_at', 'updated_at', 'count', 'offset', 'page', 'page_size', 'target', 'pinned', 'codec',
    'thumbnail_url', 'guardian_id', 'enrollment_status', 'profile_photo', 'key', 'word', 'number', 'page_number',
  ]) {
    assert.equal(isWithheld(name), false, name);
  }
});

test('the parse drops them at any depth and keeps everything else; only names are collected, never values', () => {
  const seen = new Set();
  const parsed = parseWithheld(
    JSON.stringify({
      object_id: 'a-1',
      raw_passcode: '4821',
      activities: [{ object_id: 'b-2', target: { first_name: 'Robin', raw_passcode: '4821', invite_code: 'INVITE-NEVER-STORE', phone_1: '+15550000000' } }],
      'weird key 4821 code': 'x',
    }),
    seen,
  );
  assert.deepEqual(parsed, { object_id: 'a-1', activities: [{ object_id: 'b-2', target: { first_name: 'Robin' } }] });
  assert.deepEqual([...seen].sort(), ['(a field with an unusual name)', 'invite_code', 'phone_1', 'raw_passcode']);
});

test("the client's parsed answers never hold them: the account, the children and the feed", async () => {
  const client = new BrightwheelClient({ session: new Secret(SESSION), baseUrl: `${mock.url}/api/v1`, delayMs: 0 });
  // request() is private to TypeScript only. It is where every answer from Brightwheel is parsed.
  const me = await client.request('/users/me', 'users/me');
  assert.equal(me.object_id, 'guardian-xyz-999', 'what the tool reads is still there');
  assertNoneOf(JSON.stringify(me), '/users/me');

  const kids = await client.request(`/guardians/${me.object_id}/students`, 'students');
  assertNoneOf(JSON.stringify(kids), 'the children');
  assert.deepEqual(kids.students.map((k) => k.student.first_name), ['Robin', 'Sam'], 'and the children are still named');

  const [first] = await client.students(me.object_id);
  const feed = await client.request(`/students/${first.id}/activities?page=0&page_size=100`, 'activities');
  const records = feed.activities ?? feed.data;
  assert.ok(records.length > 0 && records.every((r) => r.target && r.target.first_name), 'each record still names the child');
  assert.ok(records.some((r) => r.action_type === 'ac_checkin'), 'check-in records included');
  assertNoneOf(JSON.stringify(feed), 'the feed');

  const page = await client.activitiesPage(first.id, 0);
  assert.ok(page.items.length > 0, 'the photos are still found');
});

test('verify says Brightwheel sent them, by name only, and its report holds no value', async () => {
  const report = await verify(new Secret(SESSION), { baseUrl: `${mock.url}/api/v1` });
  const line = report.findings.find((f) => f.startsWith('WITHHELD:'));
  assert.ok(line, 'the report says what was dropped');
  for (const name of NAMES.filter((n) => n !== 'phone_2')) assert.match(line, new RegExp(`\`${name}\``));
  const text = JSON.stringify(report) + formatReport(report);
  for (const value of VALUES) assert.ok(!text.includes(value), `the report holds "${value}"`);
});

test('an answer that is not JSON is reported without quoting it', async () => {
  // JSON.parse's own message quotes the text around the fault: here, the passcode.
  const broken = '{"object":{"object_id":"g-1","raw_passcode":"4821","x":NaN}}';
  const fetchImpl = async () => new Response(broken, { status: 200, headers: { 'content-type': 'application/json' } });
  await assert.rejects(verify(new Secret(SESSION), { baseUrl: 'https://api.example.invalid/v1', fetchImpl }), (error) => {
    assert.match(error.message, /not JSON that could be read/);
    assert.ok(!error.message.includes('4821'), error.message);
    return true;
  });
  // The client's own request() says only "Could not parse JSON from <context>", after its
  // retries, which take fifteen seconds to run out; that path is not waited for here.
});

test('every answer from Brightwheel goes through the withholding parse', async () => {
  // The two places the tool reads Brightwheel's answers. A plain JSON.parse, or a response's
  // own .json(), in either would hold the codes again, however careful the parsers after it are.
  for (const file of ['../src/api/client.ts', '../src/verify.ts']) {
    const source = await readFile(new URL(file, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /JSON\.parse\(/, file);
    assert.doesNotMatch(source, /\.json\(\)/, file);
    assert.match(source, /parseWithheld\(/, file);
  }
});
