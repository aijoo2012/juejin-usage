import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { parseQoderIncremental } from '../src/parsers/qoder.js';
import { qoderCliVariants, qoderWorkVariants } from '../src/paths.js';
import { pinHomeEnv } from './platform-fixtures.js';

function transcriptLine(
  id: string,
  ts: string,
  usage: Record<string, number>,
  model = 'qfmodel',
): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: ts,
    message: { id, model, usage },
  });
}

test('qoder CN CLI projects dir is picked up as its own collector variant', () => {
  const collectors = qoderCliVariants().map((v) => v.collector);
  assert.deepEqual(collectors, ['qoder-cli', 'qoder-cn-cli']);
  assert.ok(qoderCliVariants()[1]!.projectsDir.includes('.qoder-cn'));

  const workCollectors = qoderWorkVariants().map((v) => v.collector);
  assert.deepEqual(workCollectors, ['qoder-work', 'qoder-cn-work']);
  assert.ok(qoderWorkVariants()[1]!.projectsDir.includes('.qoderworkcn'));
});

test('parseQoderIncremental reads CN CLI transcripts: credits as spend, qfmodel renamed', async () => {
  const home = await mkdtemp(join(tmpdir(), 'jusage-qoder-cn-'));
  const restore = pinHomeEnv(home);
  try {
    const proj = join(home, '.qoder-cn', 'projects', 'I--demo-project');
    await mkdir(proj, { recursive: true });
    const lines = [
      // CN CLI normal request: zero token counts, credits amount.
      transcriptLine('m1', '2026-11-05T13:40:20.593Z', {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        credits: 1.25,
      }),
      // Real-token usage still takes the anthropic path.
      transcriptLine('m2', '2026-11-05T14:40:20.593Z', {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      }),
      // All-zero usage without credits is dropped.
      transcriptLine('m3', '2026-11-05T15:40:20.593Z', {
        input_tokens: 0,
        output_tokens: 0,
      }),
    ];
    await writeFile(join(proj, 's1.jsonl'), lines.join('\n') + '\n');

    const { result } = await parseQoderIncremental({}, '2020-01-01T00:00:00.000Z');
    assert.equal(result.eventsParsed, 2);

    const creditBucket = result.buckets.find((b) => b.total_tokens === 1.25);
    assert.ok(creditBucket, 'credits-only request should be counted');
    assert.equal(creditBucket.model, 'Qwen3.8-Flash');
    assert.equal(creditBucket.collector, 'qoder-cn-cli');
    assert.equal(creditBucket.output_tokens, 1.25);
    assert.equal(creditBucket.conversation_count, 1);

    const tokenBucket = result.buckets.find((b) => b.total_tokens === 150);
    assert.ok(tokenBucket, 'real-token request should take the anthropic path');
    assert.equal(tokenBucket.model, 'Qwen3.8-Flash');
    assert.equal(tokenBucket.collector, 'qoder-cn-cli');
    assert.equal(tokenBucket.input_tokens, 100);
    assert.equal(tokenBucket.output_tokens, 50);
  } finally {
    restore();
  }
});

test('parseQoderIncremental keeps intl CLI and CN CLI collectors separate', async () => {
  const home = await mkdtemp(join(tmpdir(), 'jusage-qoder-split-'));
  const restore = pinHomeEnv(home);
  try {
    const intl = join(home, '.qoder', 'projects', 'C--intl-demo');
    const cn = join(home, '.qoder-cn', 'projects', 'I--cn-demo');
    await mkdir(intl, { recursive: true });
    await mkdir(cn, { recursive: true });
    const usage = { input_tokens: 10, output_tokens: 5 };
    await writeFile(
      join(intl, 'a.jsonl'),
      transcriptLine('x1', '2026-11-05T13:40:20.593Z', usage, 'claude-sonnet') + '\n',
    );
    await writeFile(
      join(cn, 'b.jsonl'),
      transcriptLine('x2', '2026-11-05T13:45:20.593Z', {
        input_tokens: 0,
        output_tokens: 0,
        credits: 2,
      }) + '\n',
    );

    const { result } = await parseQoderIncremental({}, '2020-01-01T00:00:00.000Z');
    assert.equal(result.eventsParsed, 2);
    const collectors = new Set(result.buckets.map((b) => b.collector));
    assert.ok(collectors.has('qoder-cli'));
    assert.ok(collectors.has('qoder-cn-cli'));
  } finally {
    restore();
  }
});
