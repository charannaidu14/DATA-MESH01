class ActivityService {
  constructor(maxEvents = 50) {
    this.maxEvents = maxEvents;
    this.activityEvents = [];
    this.recoveryEvents = [];
  }

  recordActivity({ type, status = 'ok', message, time = new Date().toISOString() }) {
    const event = { time, type, status, message };
    this.activityEvents.unshift(event);
    if (this.activityEvents.length > this.maxEvents) {
      this.activityEvents.length = this.maxEvents;
    }
    return event;
  }

  recordRecovery({ type, status = 'ok', message, time = new Date().toISOString() }) {
    const event = { time, type, status, message };
    this.recoveryEvents.unshift(event);
    if (this.recoveryEvents.length > this.maxEvents) {
      this.recoveryEvents.length = this.maxEvents;
    }
    this.recordActivity(event);
    return event;
  }

  getActivity() {
    return [...this.activityEvents];
  }

  getRecoveryEvents() {
    return [...this.recoveryEvents];
  }

  clear() {
    this.activityEvents = [];
    this.recoveryEvents = [];
  }
}

module.exports = new ActivityService();

