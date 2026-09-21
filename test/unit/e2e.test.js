import test from 'node:test';
import assert from 'node:assert/strict';
import { run, compile } from '../../src/index.js';

test('e2e: executes smart_security script seamlessly', () => {
    const code = `
    let motion = getSensors('motion') |> filter(fn(s: Map) { s.value > 0 })

    if len(motion) > 0 {
        if state.is_armed {
            let triggered = motion |> first()
            state.last_breach_room = triggered.room
            state.last_incident = getTime()
            notify("Intrusion detected in " + state.last_breach_room, 3)
        } else {
            let current_time = getTime()
            state.unarmed_motion_events = state.unarmed_motion_events |> append(current_time)

            if len(state.unarmed_motion_events) > 5 {
                state.unarmed_motion_events = state.unarmed_motion_events |> tail(5)
            }
        }
    }
    `;

    const notifiedMessages = [];
    const context = {
        getSensors: (type) => [
            { id: 'm1', value: 1, room: 'garage' },
            { id: 'm2', value: 0, room: 'hallway' }
        ],
        getTime: () => 1700000000,
        notify: (msg, priority) => {
            notifiedMessages.push({ msg, priority });
            return true;
        }
    };

    // Run 1: When armed
    const state1 = { is_armed: true };
    const updated1 = run(code, { context, state: state1 });
    assert.equal(updated1.last_breach_room, 'garage');
    assert.equal(updated1.last_incident, 1700000000);
    assert.deepEqual(notifiedMessages, [{ msg: 'Intrusion detected in garage', priority: 3 }]);

    // Run 2: When unarmed
    const state2 = { is_armed: false, unarmed_motion_events: [1, 2, 3, 4, 5] };
    const updated2 = run(code, { context, state: state2 });
    assert.deepEqual(updated2.unarmed_motion_events, [2, 3, 4, 5, 1700000000]);
});

test('e2e: executes financial_analytics with reduce and custom fn', () => {
    const code = `
    let readings = state.usage_history |> sortBy(fn(x) { -x }) |> head(10)
    let violations = readings |> filter(fn(v: Num) { v > 100 }) |> len()

    fn addPenalty(total: Num, value: Num) -> Num {
        if value > 100 {
            total + (value * 1.5)
        } else {
            total + value
        }
    }

    let bill = readings |> reduce(50, addPenalty)
    if bill > 200 && violations > 2 {
        notify("Alert: High usage detected", 1)
    }
    state.total_bill = bill
    `;

    let alertSent = false;
    const context = {
        notify: (msg, prio) => {
            alertSent = true;
            return true;
        }
    };
    const state = {
        usage_history: [120, 80, 150, 40, 200, 90, 110, 30]
    };

    const updated = run(code, { context, state });
    assert.equal(alertSent, true);
    assert.equal(updated.total_bill > 200, true);
});

test('e2e: executes eco_optimizer with clamp and round', () => {
    const code = `
    let tempSensors = getSensors('temperature') |> filter(s -> s.room == 'living_room')
    let avgTemp = tempSensors |> map(s -> s.value) |> avg()
    let roundedAvg = avgTemp |> clamp(18, 30) |> round()

    state.last_avg_temp = roundedAvg

    let weather = getWeather()
    if contains(weather.forecast, 'Sunny') && roundedAvg > 25 {
        let acUnits = getSensors('ac_unit') |> filter(s -> s.room == 'living_room')
        acUnits |> map(d -> setDeviceState(d.id, false))
    }
    `;

    const devicesTurnedOff = [];
    const context = {
        getSensors: (type) => {
            if (type === 'temperature') {
                return [
                    { id: 't1', room: 'living_room', value: 27.8 },
                    { id: 't2', room: 'living_room', value: 28.2 },
                    { id: 't3', room: 'bedroom', value: 20.0 }
                ];
            }
            if (type === 'ac_unit') {
                return [
                    { id: 'ac1', room: 'living_room', value: 1 }
                ];
            }
            return [];
        },
        getWeather: () => ({ temp: 31, forecast: 'Sunny and clear', humidity: 40 }),
        setDeviceState: (id, active) => {
            devicesTurnedOff.push({ id, active });
            return true;
        }
    };

    const state = {};
    const updated = run(code, { context, state });
    assert.equal(updated.last_avg_temp, 28);
    assert.deepEqual(devicesTurnedOff, [{ id: 'ac1', active: false }]);
});

test('e2e: executes loops using range builtin with map and reduce', () => {
    const code = `
    range(1, 4) |> map(fn(i: Num) {
        notify("Attempt " + i, 1)
    })

    let sum1To10 = range(1, 11) |> sum()
    state.sum = sum1To10

    let countdown = range(5, 0) |> reduce("", fn(acc: Str, n: Num) {
        acc + n + " "
    })
    state.countdown = trim(countdown)
    `;

    const notifications = [];
    const context = {
        notify: (msg, prio) => {
            notifications.push({ msg, prio });
            return true;
        }
    };
    const state = {};
    const updated = run(code, { context, state });

    assert.deepEqual(notifications, [
        { msg: 'Attempt 1', prio: 1 },
        { msg: 'Attempt 2', prio: 1 },
        { msg: 'Attempt 3', prio: 1 }
    ]);
    assert.equal(updated.sum, 55);
    assert.equal(updated.countdown, '5 4 3 2 1');
});
