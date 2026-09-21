/**
 * @fileoverview Pure JavaScript implementations of all spelllang built-in standard library functions.
 */

/**
 * Filter a list using a predicate.
 * @param {Array} list
 * @param {Function} predicate
 * @returns {Array}
 */
export function filter(list, predicate) {
    if (!Array.isArray(list)) return [];
    return list.filter(predicate);
}

/**
 * Map a list using a transform function.
 * @param {Array} list
 * @param {Function} transform
 * @returns {Array}
 */
export function map(list, transform) {
    if (!Array.isArray(list)) return [];
    return list.map(transform);
}

/**
 * Maps each element using a transform function and flattens the result by one level.
 * @param {Array} list
 * @param {Function} transform
 * @returns {Array}
 */
export function flatMap(list, transform) {
    if (!Array.isArray(list)) return [];
    return list.flatMap(transform);
}

/**
 * Reduces a list to a single value using a reducer function.
 * @param {Array} list
 * @param {*} initial
 * @param {Function} reducer
 * @returns {*}
 */
export function reduce(list, initial, reducer) {
    if (!Array.isArray(list)) return initial;
    return list.reduce((acc, item) => reducer(acc, item), initial);
}

/**
 * Counts elements in a list satisfying a predicate.
 * @param {Array} list
 * @param {Function} predicate
 * @returns {number}
 */
export function countBy(list, predicate) {
    if (!Array.isArray(list)) return 0;
    let count = 0;
    for (let i = 0; i < list.length; i++) {
        if (predicate(list[i])) count++;
    }
    return count;
}

/**
 * Returns true if at least one element satisfies the predicate.
 * @param {Array} list
 * @param {Function} predicate
 * @returns {boolean}
 */
export function any(list, predicate) {
    if (!Array.isArray(list)) return false;
    return list.some(predicate);
}

/**
 * Returns true if all elements satisfy the predicate.
 * @param {Array} list
 * @param {Function} predicate
 * @returns {boolean}
 */
export function all(list, predicate) {
    if (!Array.isArray(list)) return false;
    return list.every(predicate);
}

/**
 * Finds the first element satisfying the predicate, or null if not found.
 * @param {Array} list
 * @param {Function} predicate
 * @returns {*}
 */
export function find(list, predicate) {
    if (!Array.isArray(list)) return null;
    const match = list.find(predicate);
    return match !== undefined ? match : null;
}

/**
 * Checks if a list contains an item, or if a string contains a substring.
 * @param {Array|string} target
 * @param {*} item
 * @returns {boolean}
 */
export function contains(target, item) {
    if (typeof target === 'string') {
        return target.includes(String(item));
    }
    if (Array.isArray(target)) {
        return target.includes(item);
    }
    return false;
}

/**
 * Appends an item to a list immutably.
 * @param {Array} list
 * @param {*} item
 * @returns {Array}
 */
export function append(list, item) {
    if (!Array.isArray(list)) return [item];
    return [...list, item];
}

/**
 * Returns a reversed copy of a list.
 * @param {Array} list
 * @returns {Array}
 */
export function reverse(list) {
    if (!Array.isArray(list)) return [];
    return [...list].reverse();
}

/**
 * Returns a sorted copy of a list based on key function or natural order.
 * @param {Array} list
 * @param {Function} [keyFn]
 * @returns {Array}
 */
export function sortBy(list, keyFn) {
    if (!Array.isArray(list)) return [];
    const copy = [...list];
    if (typeof keyFn !== 'function') {
        return copy.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    }
    return copy.sort((a, b) => {
        const ka = keyFn(a);
        const kb = keyFn(b);
        return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
}

/**
 * Sums numeric elements in a list.
 * @param {Array<number>} list
 * @returns {number}
 */
export function sum(list) {
    if (!Array.isArray(list)) return 0;
    return list.reduce((acc, x) => acc + (typeof x === 'number' ? x : 0), 0);
}

/**
 * Calculates average of numeric elements in a list.
 * @param {Array<number>} list
 * @returns {number}
 */
export function avg(list) {
    if (!Array.isArray(list) || list.length === 0) return 0;
    return sum(list) / list.length;
}

/**
 * Minimum value in numeric list.
 * @param {Array<number>} list
 * @returns {number}
 */
export function min(list) {
    if (!Array.isArray(list) || list.length === 0) return 0;
    return Math.min(...list);
}

/**
 * Maximum value in numeric list.
 * @param {Array<number>} list
 * @returns {number}
 */
export function max(list) {
    if (!Array.isArray(list) || list.length === 0) return 0;
    return Math.max(...list);
}

/**
 * Returns the first element of a list, or null.
 * @param {Array} list
 * @returns {*}
 */
export function first(list) {
    if (!Array.isArray(list) || list.length === 0) return null;
    return list[0];
}

/**
 * Returns the last element of a list, or null.
 * @param {Array} list
 * @returns {*}
 */
export function last(list) {
    if (!Array.isArray(list) || list.length === 0) return null;
    return list[list.length - 1];
}

/**
 * Takes the first n elements of a list.
 * @param {Array} list
 * @param {number} [n=1]
 * @returns {Array}
 */
export function head(list, n = 1) {
    if (!Array.isArray(list)) return [];
    return list.slice(0, Math.max(0, n));
}

/**
 * Takes the last n elements of a list.
 * @param {Array} list
 * @param {number} [n=1]
 * @returns {Array}
 */
export function tail(list, n = 1) {
    if (!Array.isArray(list)) return [];
    if (n <= 0) return [];
    return list.slice(-n);
}

/**
 * Returns length of list or string.
 * @param {Array|string} target
 * @returns {number}
 */
export function len(target) {
    if (target == null) return 0;
    return target.length ?? 0;
}

/**
 * Safely accesses a property from a map/object.
 * @param {Object} obj
 * @param {string} key
 * @param {*} [defaultVal=null]
 * @returns {*}
 */
export function get(obj, key, defaultVal = null) {
    if (obj == null || typeof obj !== 'object') return defaultVal;
    const val = obj[key];
    return val !== undefined ? val : defaultVal;
}

/* Math functions */

export function abs(x) { return Math.abs(x); }
export function floor(x) { return Math.floor(x); }
export function ceil(x) { return Math.ceil(x); }
export function round(x) { return Math.round(x); }
export function sqrt(x) { return Math.sqrt(x); }
export function pow(base, exp) { return Math.pow(base, exp); }
export function sin(angle) { return Math.sin(angle); }
export function cos(angle) { return Math.cos(angle); }
export function tan(angle) { return Math.tan(angle); }
export function atan2(y, x) { return Math.atan2(y, x); }
export function sign(x) { return Math.sign(x); }

export function clamp(val, minVal, maxVal) {
    return Math.min(Math.max(val, minVal), maxVal);
}

export function random(minVal = 0, maxVal = 1) {
    return minVal + Math.random() * (maxVal - minVal);
}

/* String functions */

export function split(str, delimiter) {
    if (typeof str !== 'string') return [];
    return str.split(delimiter);
}

export function join(list, delimiter = '') {
    if (!Array.isArray(list)) return '';
    return list.join(delimiter);
}

export function trim(str) {
    if (typeof str !== 'string') return '';
    return str.trim();
}

/**
 * All built-in standard library functions gathered in an object.
 */
export const BUILTINS = {
    filter,
    map,
    flatMap,
    reduce,
    countBy,
    any,
    all,
    find,
    contains,
    append,
    reverse,
    sortBy,
    sum,
    avg,
    min,
    max,
    first,
    last,
    head,
    tail,
    len,
    get,
    abs,
    floor,
    ceil,
    round,
    sqrt,
    pow,
    sin,
    cos,
    tan,
    atan2,
    clamp,
    random,
    sign,
    split,
    join,
    trim
};

export const BUILTIN_NAMES = new Set(Object.keys(BUILTINS));
