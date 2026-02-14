const EventEmitter = require('events');
const IpotExecutionEngine = require('./ipot');

const ENGINE_EVENT_NAMES = [
  'connected',
  'disconnected',
  'error',
  'order-submitted',
  'order-ack',
  'order-error',
  'order-update',
  'auth-token-updated'
];

class ExecutionRegistry extends EventEmitter {
  constructor() {
    super();
    this.engines = new Map();
    this._engineForwarders = new Map();
    this.activeBroker = null;
    this._activeEngine = null;

    this.register('ipot', IpotExecutionEngine);
    this.setActiveBroker('ipot');
  }

  register(broker, engine) {
    const key = (broker || '').toLowerCase();
    if (!key) {
      throw new Error('ExecutionRegistry.register requires a broker key');
    }
    if (!engine || typeof engine.on !== 'function') {
      throw new Error(`Execution engine for broker "${key}" must be an EventEmitter instance`);
    }
    this.engines.set(key, engine);
  }

  setActiveBroker(broker) {
    const key = (broker || '').toLowerCase();
    if (!key) {
      this.emit('error', new Error('setActiveBroker requires broker name'));
      return false;
    }
    const engine = this.engines.get(key);
    if (!engine) {
      this.emit('error', new Error(`Execution engine for broker "${key}" is not registered`));
      return false;
    }
    if (engine === this._activeEngine) {
      this.activeBroker = key;
      return true;
    }

    if (this._activeEngine) {
      this._unwireEngineEvents(this._activeEngine);
    }

    this._activeEngine = engine;
    this.activeBroker = key;
    this._wireEngineEvents(engine);
    this.emit('broker-changed', key);
    return true;
  }

  getActiveBroker() {
    return this.activeBroker;
  }

  getEngine(broker) {
    const key = (broker || '').toLowerCase();
    return this.engines.get(key) || null;
  }

  connect(options) {
    if (!this._activeEngine || typeof this._activeEngine.connect !== 'function') {
      throw new Error('No active execution engine selected');
    }
    return this._activeEngine.connect(options);
  }

  disconnect() {
    if (this._activeEngine && typeof this._activeEngine.disconnect === 'function') {
      return this._activeEngine.disconnect();
    }
    return undefined;
  }

  isConnected() {
    return Boolean(this._activeEngine && typeof this._activeEngine.isConnected === 'function' && this._activeEngine.isConnected());
  }

  isConnecting() {
    return Boolean(this._activeEngine && typeof this._activeEngine.isConnecting === 'function' && this._activeEngine.isConnecting());
  }

  placeBuy(params) {
    if (!this._activeEngine || typeof this._activeEngine.placeBuy !== 'function') {
      throw new Error('Active execution engine does not support placeBuy');
    }
    return this._activeEngine.placeBuy(params);
  }

  placeSell(params) {
    if (!this._activeEngine || typeof this._activeEngine.placeSell !== 'function') {
      throw new Error('Active execution engine does not support placeSell');
    }
    return this._activeEngine.placeSell(params);
  }

  _wireEngineEvents(engine) {
    const forwarders = {};
    ENGINE_EVENT_NAMES.forEach((eventName) => {
      const handler = (...args) => this.emit(eventName, ...args);
      engine.on(eventName, handler);
      forwarders[eventName] = handler;
    });
    this._engineForwarders.set(engine, forwarders);
  }

  _unwireEngineEvents(engine) {
    const forwarders = this._engineForwarders.get(engine);
    if (!forwarders) {
      return;
    }
    Object.entries(forwarders).forEach(([eventName, handler]) => {
      if (typeof engine.off === 'function') {
        engine.off(eventName, handler);
      } else {
        engine.removeListener(eventName, handler);
      }
    });
    this._engineForwarders.delete(engine);
  }
}

module.exports = new ExecutionRegistry();
