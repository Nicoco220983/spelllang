import test from 'node:test';
import assert from 'node:assert/strict';
import * as b from '../../src/builtins.js';

test('builtins: list operations', () => {
    assert.deepEqual(b.filter([1, 2, 3, 4], x => x % 2 === 0), [2, 4]);
    assert.deepEqual(b.map([1, 2, 3], x => x * 2), [2, 4, 6]);
    assert.deepEqual(b.flatMap([[1], [2, 3]], x => x), [1, 2, 3]);
    assert.equal(b.reduce([1, 2, 3], 10, (acc, x) => acc + x), 16);
    assert.equal(b.countBy([10, 20, 150, 200], x => x > 100), 2);
    assert.equal(b.any([1, 2, 3], x => x === 2), true);
    assert.equal(b.any([1, 2, 3], x => x === 9), false);
    assert.equal(b.all([2, 4, 6], x => x % 2 === 0), true);
    assert.equal(b.all([2, 5, 6], x => x % 2 === 0), false);

    assert.equal(b.find([1, 2, 3], x => x > 1), 2);
    assert.equal(b.find([1, 2, 3], x => x > 10), null);

    assert.equal(b.contains([1, 2, 3], 2), true);
    assert.equal(b.contains([1, 2, 3], 5), false);
    assert.equal(b.contains("Sunny weather", "Sunny"), true);
    assert.equal(b.contains("Rainy", "Sunny"), false);

    assert.deepEqual(b.append([1, 2], 3), [1, 2, 3]);
    assert.deepEqual(b.reverse([1, 2, 3]), [3, 2, 1]);

    const users = [{ age: 30 }, { age: 20 }, { age: 25 }];
    assert.deepEqual(b.sortBy(users, u => u.age), [{ age: 20 }, { age: 25 }, { age: 30 }]);

    assert.equal(b.sum([10, 20, 30]), 60);
    assert.equal(b.avg([10, 20, 30]), 20);
    assert.equal(b.min([10, 5, 30]), 5);
    assert.equal(b.max([10, 5, 30]), 30);

    assert.equal(b.first([10, 20, 30]), 10);
    assert.equal(b.first([]), null);
    assert.equal(b.last([10, 20, 30]), 30);
    assert.equal(b.last([]), null);

    assert.deepEqual(b.head([1, 2, 3, 4, 5], 3), [1, 2, 3]);
    assert.deepEqual(b.tail([1, 2, 3, 4, 5], 2), [4, 5]);
    assert.equal(b.len([1, 2, 3]), 3);
    assert.equal(b.len("hello"), 5);

    assert.deepEqual(b.range(5), [0, 1, 2, 3, 4]);
    assert.deepEqual(b.range(1, 5), [1, 2, 3, 4]);
    assert.deepEqual(b.range(0, 10, 2), [0, 2, 4, 6, 8]);
    assert.deepEqual(b.range(5, 0), [5, 4, 3, 2, 1]);
    assert.deepEqual(b.range(5, 0, -1), [5, 4, 3, 2, 1]);
    assert.deepEqual(b.range(10, 0, -2), [10, 8, 6, 4, 2]);
    assert.deepEqual(b.range(5, 5), []);
    assert.deepEqual(b.range(0), []);
    assert.deepEqual(b.range(5, 1, 1), []);
    assert.deepEqual(b.range(1, 5, -1), []);
    assert.deepEqual(b.range(1, 5, 0), []);
    assert.deepEqual(b.range(-3), [0, -1, -2]);
    assert.deepEqual(b.range(-2, 2), [-2, -1, 0, 1]);
    assert.deepEqual(b.range(null), []);
    assert.deepEqual(b.range("abc"), []);
    assert.deepEqual(b.range(1, "abc"), []);

    assert.equal(b.get({ a: 100 }, "a"), 100);
    assert.equal(b.get({ a: 100 }, "b", "default"), "default");
});

test('builtins: math & string operations', () => {
    assert.equal(b.abs(-5), 5);
    assert.equal(b.floor(4.9), 4);
    assert.equal(b.ceil(4.1), 5);
    assert.equal(b.round(4.5), 5);
    assert.equal(b.sqrt(16), 4);
    assert.equal(b.pow(2, 3), 8);
    assert.equal(b.sin(0), 0);
    assert.equal(b.cos(0), 1);
    assert.equal(b.clamp(35, 18, 30), 30);
    assert.equal(b.clamp(10, 18, 30), 18);
    assert.equal(b.clamp(25, 18, 30), 25);
    assert.equal(b.sign(-50), -1);
    assert.equal(b.sign(50), 1);

    assert.deepEqual(b.split("a,b,c", ","), ["a", "b", "c"]);
    assert.equal(b.join(["a", "b", "c"], "-"), "a-b-c");
    assert.equal(b.trim("  hello  "), "hello");
});
