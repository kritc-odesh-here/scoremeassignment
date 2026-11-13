const {
  APPLICATION_STATES,
  TERMINAL_STATES,
  VALID_TRANSITIONS,
  InvalidStateTransitionError
} = require('./states');

class StateMachine {
  static canTransition(fromState, toState) {
    if (!fromState || !toState) return false;
    const allowed = VALID_TRANSITIONS[fromState];
    if (!allowed) return false;
    return allowed.includes(toState);
  }

  static assertTransition(fromState, toState, trackingNumber = '') {
    if (!this.canTransition(fromState, toState)) {
      throw new InvalidStateTransitionError(fromState, toState, trackingNumber);
    }
  }

  static isTerminal(state) {
    return TERMINAL_STATES.has(state);
  }
}

module.exports = {
  StateMachine,
  APPLICATION_STATES,
  TERMINAL_STATES,
  InvalidStateTransitionError
};

