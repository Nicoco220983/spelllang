import test from 'node:test';
import assert from 'node:assert/strict';
import { generatePrompt } from '../../src/index.js';

test('prompt: generates complete prompt from schema', () => {
    const prompt = generatePrompt({
        title: 'Smart Home Automation Guide',
        functions: [
            {
                name: 'getSensors',
                signature: 'getSensors(type: Str): List<Map>',
                description: 'Returns all sensors for the given type'
            },
            {
                name: 'notify',
                signature: 'notify(message: Str, priority: Num): Bool',
                description: 'Sends push notification'
            }
        ],
        state: {
            is_armed: 'Bool (Whether system is armed)',
            last_breach_room: 'Str (Room of last intrusion)'
        },
        instructions: 'Focus on energy saving during daytime hours.'
    });

    assert.match(prompt, /# Smart Home Automation Guide/);
    assert.match(prompt, /getSensors\(type: Str\): List<Map>/);
    assert.match(prompt, /notify\(message: Str, priority: Num\): Bool/);
    assert.match(prompt, /state\.is_armed.*Bool/);
    assert.match(prompt, /state\.last_breach_room.*Str/);
    assert.match(prompt, /Focus on energy saving during daytime hours\./);
    assert.match(prompt, /filter\(list: List, predicate: Fn\): List/);
    assert.match(prompt, /clamp\(val: Num, min: Num, max: Num\): Num/);
});
