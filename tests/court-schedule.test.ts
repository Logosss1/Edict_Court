// Court schedule (who stands where, by hour + session + work) and the walkable-floor router.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { festivalOf, homeOf, leaveHour, lunarDate, moonPhase, nextHop, periodAt, placeOf, tickSession, excused, type Session } from '../src/renderer/court/game/schedule';
import { nearestFloor, onFloor, route, stepOnFloor, type Rect } from '../src/renderer/court/game/walk';
import { flowKind } from '../src/renderer/court/game/scenes';

const at = (hour: number, session = false, busy = false) => ({ hour, session, busy });

test('periods follow the palace day', () => {
  assert.equal(periodAt(5.5), 'dawn');
  assert.equal(periodAt(7), 'chaohui');
  assert.equal(periodAt(11), 'office');
  assert.equal(periodAt(18), 'sanzhi');
  assert.equal(periodAt(22), 'night');
  assert.equal(periodAt(2), 'night');
});

test('in session the court is in the hall, a busy ministry stays at its desk', () => {
  assert.equal(placeOf('zhongshu', at(11, true)), 'taihe');
  assert.equal(placeOf('taizi', at(23.5, true)), 'taihe');
  assert.equal(placeOf('bingbu', at(11, true)), 'taihe');
  assert.equal(placeOf('bingbu', at(11, true, true)), 'liubu');
  assert.ok(excused('bingbu', at(11, true, true)));
  assert.ok(!excused('menxia', at(11, true, true)));
  // 三省 attend even with work in hand
  assert.equal(placeOf('menxia', at(11, true, true)), 'taihe');
});

test('out of session: offices by day, home at night, work keeps them at their desks', () => {
  assert.equal(placeOf('zhongshu', at(11)), 'junjichu');
  assert.equal(placeOf('hubu', at(11)), 'liubu');
  assert.equal(placeOf('taizi', at(11)), 'donggong');
  assert.equal(placeOf('zaochao', at(11)), 'chengtian');
  assert.equal(placeOf('hubu', at(22)), 'out');
  assert.equal(placeOf('hubu', at(22, false, true)), 'liubu'); // 挑灯办差
  assert.equal(placeOf('taizi', at(22)), 'donggong');
  assert.equal(placeOf('taizi', at(2)), 'out');
  // morning court was dismissed early: back to the office
  assert.equal(placeOf('menxia', at(7)), 'junjichu');
  // before court the officials wait on the square
  assert.equal(placeOf('libu', at(5.5)), 'guangchang');
  assert.equal(homeOf('solo'), 'junjichu');
});

test('officials leave one by one between 17 and 19', () => {
  const hours = ['zhongshu', 'menxia', 'shangshu', 'hubu', 'libu', 'bingbu', 'xingbu', 'gongbu', 'libu_hr'].map(leaveHour);
  for (const h of hours) assert.ok(h >= 17 && h < 19, String(h));
  assert.ok(new Set(hours.map((h) => h.toFixed(2))).size > 4, 'they should not all leave at once');
  const id = 'hubu';
  assert.equal(placeOf(id, at(leaveHour(id) - 0.01)), 'liubu');
  assert.equal(placeOf(id, at(leaveHour(id) + 0.01)), 'out');
});

test('routes between halls follow the doors', () => {
  assert.equal(nextHop('taihe', 'liubu'), 'guangchang');
  assert.equal(nextHop('guangchang', 'liubu'), 'chengtian');
  assert.equal(nextHop('taihe', 'junjichu'), 'junjichu');
  assert.equal(nextHop('yuhuayuan', 'taihe'), 'gongdao');
  assert.equal(nextHop('taihe', 'out'), 'guangchang');
  assert.equal(nextHop('chengtian', 'out'), 'out');
  assert.equal(nextHop('liubu', 'out'), 'out');
  assert.equal(nextHop('taihe', 'taihe'), null);
});

test('morning court opens itself once, and any session closes when idle', () => {
  const day = new Date(2026, 9, 13, 7, 0);
  const idle = 5 * 60000;
  let s: Session = { active: false, manual: false, lastInput: day.getTime(), dismissed: '' };
  let r = tickSession(s, day, 7, idle);
  assert.equal(r.event, 'open');
  s = r.s;
  r = tickSession(s, new Date(day.getTime() + 4 * 60000), 7.07, idle);
  assert.equal(r.event, null);
  r = tickSession(s, new Date(day.getTime() + 6 * 60000), 7.1, idle);
  assert.equal(r.event, 'close');
  s = r.s;
  // dismissed for today: it does not open again this morning
  r = tickSession(s, new Date(day.getTime() + 10 * 60000), 7.2, idle);
  assert.equal(r.event, null);
  // a morning session ends at 9 even with input
  const nine = new Date(2026, 9, 14, 9, 1);
  r = tickSession({ active: true, manual: false, lastInput: nine.getTime(), dismissed: '' }, nine, 9.02, idle);
  assert.equal(r.event, 'close');
  // a session the emperor called himself runs on past 9 until he stops touching anything
  r = tickSession({ active: true, manual: true, lastInput: nine.getTime(), dismissed: '' }, nine, 9.02, idle);
  assert.equal(r.event, null);
  // at night nothing opens by itself
  const night = new Date(2026, 9, 14, 22, 0);
  assert.equal(tickSession({ active: false, manual: false, lastInput: 0, dismissed: '' }, night, 22, idle).event, null);
});

test('moon phase and festivals', () => {
  // 2026-10-26 is close to a full moon, 2026-10-10 close to a new moon
  const full = moonPhase(new Date(Date.UTC(2026, 9, 26, 12)));
  assert.ok(Math.abs(full - 0.5) < 0.08, String(full));
  const fresh = moonPhase(new Date(Date.UTC(2026, 9, 10, 12)));
  assert.ok(fresh < 0.08 || fresh > 0.92, String(fresh));
  const l = lunarDate(new Date(2026, 1, 17));
  if (l) {
    // 2026-02-17 is 春节 (正月初一)
    assert.deepEqual([l.month, l.day], [1, 1]);
    assert.equal(festivalOf(new Date(2026, 1, 17)), 'chunjie');
    assert.equal(festivalOf(new Date(2026, 2, 3)), 'yuanxiao');
    assert.equal(festivalOf(new Date(2026, 8, 25)), 'zhongqiu');
    assert.equal(festivalOf(new Date(2026, 5, 1)), null);
  }
});

test('walking: rooms joined by a doorway route through it', () => {
  // a courtyard strip with a room above it, joined by a narrow doorway
  const rects: Rect[] = [
    { x0: 10, x1: 630, y0: 170, y1: 200 }, // courtyard
    { x0: 40, x1: 180, y0: 60, y1: 140 }, // room
    { x0: 100, x1: 120, y0: 138, y1: 172 }, // doorway
  ];
  const pts = route(rects, [500, 185], [60, 80]);
  assert.ok(pts.length >= 3);
  // goes through the doorway before entering the room
  assert.ok(pts.some(([x, y]) => x >= 100 && x <= 120 && y > 136 && y < 174), JSON.stringify(pts));
  assert.deepEqual(pts[pts.length - 1], [60, 80]);
  for (const [x, y] of pts) assert.ok(onFloor(rects, x, y, 1));
  // keyboard steps slide along walls instead of entering them
  assert.deepEqual(stepOnFloor(rects, 300, 172, 0, -3), [300, 172]);
  assert.deepEqual(stepOnFloor(rects, 300, 172, 2, -3), [302, 172]);
  assert.deepEqual(nearestFloor(rects, 300, 100), [300, 170]);
  assert.deepEqual(nearestFloor(rects, 200, 90), [180, 90]);
});

test('flow remarks are acted out as reject / approve / pass', () => {
  assert.equal(flowKind('封驳：方案欠妥'), 'reject');
  assert.equal(flowKind('门下省准奏，用印'), 'approve');
  assert.equal(flowKind('转中书省拟旨'), 'pass');
});
