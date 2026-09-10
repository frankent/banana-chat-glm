import { expect, it } from 'vitest';
import { TypingState } from './typing.js';
it('TC-RT-020 typing expires, refreshes and ignores self', () => {
  let time = 0;
  const state = new TypingState('me', () => time);
  state.receive('me', 'Me', true); state.receive('peer', 'Tony', true);
  expect(state.names()).toEqual(['Tony']);
  time = 5000; state.receive('peer', 'Tony', true); time = 7000;
  expect(state.names()).toEqual(['Tony']);
  time = 11000; expect(state.names()).toEqual([]);
  state.receive('peer', 'Tony', true); state.receive('peer', 'Tony', false);
  expect(state.names()).toEqual([]);
});
