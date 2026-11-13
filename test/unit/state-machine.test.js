const {
  StateMachine,
  APPLICATION_STATES,
  InvalidStateTransitionError
} = require('../../src/domain/state-machine/state-machine');

describe('Finite State Machine (FSM)', () => {
  test('Permits legal lifecycle transitions', () => {
    expect(StateMachine.canTransition(APPLICATION_STATES.RECEIVED, APPLICATION_STATES.ENRICHING)).toBe(true);
    expect(StateMachine.canTransition(APPLICATION_STATES.ENRICHING, APPLICATION_STATES.EVALUATING)).toBe(true);
    expect(StateMachine.canTransition(APPLICATION_STATES.EVALUATING, APPLICATION_STATES.APPROVED)).toBe(true);
    expect(StateMachine.canTransition(APPLICATION_STATES.EVALUATING, APPLICATION_STATES.REJECTED)).toBe(true);
    expect(StateMachine.canTransition(APPLICATION_STATES.EVALUATING, APPLICATION_STATES.MANUAL_REVIEW)).toBe(true);
    expect(StateMachine.canTransition(APPLICATION_STATES.MANUAL_REVIEW, APPLICATION_STATES.APPROVED)).toBe(true);
    expect(StateMachine.canTransition(APPLICATION_STATES.MANUAL_REVIEW, APPLICATION_STATES.REJECTED)).toBe(true);
  });

  test('Permits transition to FAILED and resumption from FAILED', () => {
    expect(StateMachine.canTransition(APPLICATION_STATES.ENRICHING, APPLICATION_STATES.FAILED)).toBe(true);
    expect(StateMachine.canTransition(APPLICATION_STATES.FAILED, APPLICATION_STATES.ENRICHING)).toBe(true);
    expect(StateMachine.canTransition(APPLICATION_STATES.FAILED, APPLICATION_STATES.EVALUATING)).toBe(true);
  });

  test('Guards terminal states: APPROVED and REJECTED cannot transition', () => {
    expect(StateMachine.isTerminal(APPLICATION_STATES.APPROVED)).toBe(true);
    expect(StateMachine.isTerminal(APPLICATION_STATES.REJECTED)).toBe(true);

    expect(StateMachine.canTransition(APPLICATION_STATES.APPROVED, APPLICATION_STATES.ENRICHING)).toBe(false);
    expect(StateMachine.canTransition(APPLICATION_STATES.APPROVED, APPLICATION_STATES.RECEIVED)).toBe(false);
    expect(StateMachine.canTransition(APPLICATION_STATES.REJECTED, APPLICATION_STATES.EVALUATING)).toBe(false);
  });

  test('assertTransition throws InvalidStateTransitionError for illegal transitions', () => {
    expect(() => {
      StateMachine.assertTransition(APPLICATION_STATES.RECEIVED, APPLICATION_STATES.APPROVED, 'APP-123');
    }).toThrow(InvalidStateTransitionError);

    expect(() => {
      StateMachine.assertTransition(APPLICATION_STATES.APPROVED, APPLICATION_STATES.REJECTED, 'APP-123');
    }).toThrow(/Illegal state transition from 'APPROVED' to 'REJECTED'/);
  });
});

