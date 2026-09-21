import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { run } from '../../src/index.js';

test('generated: executes DeepSeek smart_security.spell artifact', async () => {
    const filePath = path.join(process.cwd(), 'test/eval/output/~deepseek_deepseek-v4-flash-latest_no-thinking/smart_security.spell');
    const code = await fs.readFile(filePath, 'utf8');

    const notified = [];
    const context = {
        getSensors: (type) => [
            { id: 's1', room: 'kitchen', value: 3 }
        ],
        getTime: () => 1710000000,
        notify: (msg, priority) => {
            notified.push({ msg, priority });
            return true;
        }
    };

    const state = { is_armed: true };
    const updated = run(code, { context, state });

    assert.equal(updated.last_breach_room, 'kitchen');
    assert.equal(updated.last_incident, 1710000000);
    assert.equal(notified.length, 1);
});

test('generated: executes DeepSeek financial_analytics.spell artifact', async () => {
    const filePath = path.join(process.cwd(), 'test/eval/output/~deepseek_deepseek-v4-flash-latest_no-thinking/financial_analytics.spell');
    const code = await fs.readFile(filePath, 'utf8');

    let notified = false;
    const context = {
        identity: (x) => x,
        notify: () => { notified = true; return true; }
    };
    const state = {
        usage_history: [150, 200, 110, 50, 40]
    };

    const updated = run(code, { context, state });
    assert.equal(notified, true);
});
