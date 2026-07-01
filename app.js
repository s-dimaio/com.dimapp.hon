'use strict';

const Homey = require('homey');
const { HonAuth, HonAPI, HonDevice, MQTTClient } = require('java-hon');

/**
 * hOn SmartHome App for Homey
 * 
 * Manages authentication with hOn servers and coordinates
 * MQTT communication for real-time updates.
 */
module.exports = class HonApp extends Homey.App {

  // ═══════════════════════════════════════════════════════════════════════
  // PRIVATE UTILITY METHODS
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Setup MQTT client event handlers for connection monitoring and routing
   * Handles MQTT broker connection status (connected, disconnected, error)
   * Routes appliance-specific connection events to device listeners
   * NOTE: Parameter updates are NOT routed here — they are handled exclusively
   * via the 'attributesUpdated' event emitted by the JavahOn library (wm.js),
   * which already scopes updates to the correct appliance instance.
   * @private
   * @returns {void}
   * @example
   * // Automatically called by startMqttClient()
   * this._setupMqttRouting();
   */
  _setupMqttRouting() {
    // Handle global MQTT disconnections
    this._mqttClient.on('disconnected', () => {
      this.log('⚠️ MQTT disconnected');
      this.emit('mqtt:disconnected');
    });

    // Handle global MQTT reconnections
    this._mqttClient.on('connected', () => {
      this.log('✅ MQTT connected');
      this.emit('mqtt:connected');
    });

    // Handle global MQTT errors
    this._mqttClient.on('error', (error) => {
      this.error('MQTT error:', error.message);
      this.emit('mqtt:error', error);
    });

    // Handle appliance-specific connection changes
    // Routes connectionChange events from client to device-specific events
    this._mqttClient.on('connectionChange', ({ appliance, connected, payload }) => {
      const macAddress = appliance.macAddress || appliance.info?.macAddress;
      if (macAddress) {
        this.log(`📡 Appliance ${macAddress}: ${connected ? 'online' : 'offline'}`);
        this.emit(`mqtt:connection:${macAddress}`, connected);
      }
    });

  }

  // ═══════════════════════════════════════════════════════════════════════
  // SESSION & TOKEN MANAGEMENT
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Attempts to restore session using saved tokens from previous authentication
   * @private
   * @returns {Promise<boolean>} - Returns true if session restored successfully, false otherwise
   * @example
   * // Called automatically in onInit()
   * const restored = await this._tryRestoreSession();
   * if (restored) {
   *   console.log('Session restored from saved tokens');
   * }
   */
  async _tryRestoreSession() {
    this.log('🔑 _tryRestoreSession() - Checking for saved tokens...');
    const savedTokens = this.homey.settings.get('honTokens');

    if (!savedTokens) {
      this.log('🔑 _tryRestoreSession() - No saved tokens found, full login required');
      return false;
    }

    this.log(`🔑 _tryRestoreSession() - Found saved tokens (expiresAt: ${savedTokens.expiresAt || 'unknown'})`);

    try {

      const device = new HonDevice('Homey-Hon');
      const debugEnabled = this.isDebugEnabled();

      // Email can be null, tokens are sufficient for re-authentication
      this._auth = new HonAuth(null, null, '', device, debugEnabled);

      if (debugEnabled) {
        this.log('🐛 Debug mode ENABLED - JavahOn will output detailed logs');
      }

      // Register token handler
      this._registerTokenHandler();

      // Try to use saved tokens
      this.log('🔑 _tryRestoreSession() - Attempting setTokens()...');
      if (this._auth.setTokens(savedTokens)) {
        this.log('🔑 _tryRestoreSession() - setTokens() succeeded, session restored');
        this._api = new HonAPI(this._auth);
        return true;
      } else {
        this.log('🔑 _tryRestoreSession() - setTokens() failed (tokens likely expired), attempting refresh...');
        // Try to refresh tokens
        if (savedTokens.refreshToken) {
          try {
            const refreshed = await this._auth.refresh(savedTokens.refreshToken);
            if (refreshed) {
              this.log('🔑 _tryRestoreSession() - Token refresh succeeded');
              this._api = new HonAPI(this._auth);
              return true;
            } else {
              this.log('🔑 _tryRestoreSession() - Token refresh returned false, full login required');
            }
          } catch (refreshError) {
            this.error(`🔑 _tryRestoreSession() - Token refresh failed: ${refreshError.message}`);
          }
        } else {
          this.log('🔑 _tryRestoreSession() - No refreshToken available, full login required');
        }
      }
    } catch (error) {
      this.error('Failed to restore session:', error.message);
      if (error.response) {
        this.error(`  HTTP ${error.response.status} - ${error.response.config?.url || ''}`);
        this.error(`  Response: ${JSON.stringify(error.response.data).substring(0, 300)}`);
      }
    }

    // Clean up if restore fails
    this.log('🔑 _tryRestoreSession() - Session restore failed, cleaning up');
    this._auth = null;
    this._api = null;
    return false;
  }

  /**
   * Registers the handler for the tokens event to automatically save tokens when they are updated
   * @private
   * @returns {void}
   * @example
   * // Called after creating HonAuth instance
   * this._registerTokenHandler();
   */
  _registerTokenHandler() {
    if (!this._auth) return;

    // Remove previous handler if exists
    this._unregisterTokenHandler();

    // Create new handler
    this._tokenHandler = (tokens) => {
      this.homey.settings.set('honTokens', tokens);
    };

    // Register handler
    this._auth.on('tokens', this._tokenHandler);
  }

  /**
   * Removes the handler for the tokens event to prevent memory leaks
   * @private
   * @returns {void}
   * @example
   * // Called during logout
   * this._unregisterTokenHandler();
   */
  _unregisterTokenHandler() {
    if (this._auth && this._tokenHandler) {
      this._auth.off('tokens', this._tokenHandler);
      this._tokenHandler = null;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PUBLIC SETTINGS & AUTHENTICATION
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Gets the debug setting from app settings
   * @public
   * @returns {boolean} - Debug enabled state
   * @example
   * const debugEnabled = this.isDebugEnabled();
   * if (debugEnabled) {
   *   console.log('Debug mode is active');
   * }
   */
  isDebugEnabled() {
    const debugEnabled = this.homey.settings.get('debugEnabled');
    return debugEnabled === true;
  }


  /**
   * Performs authentication with hOn servers using provided credentials
   * Saves authentication tokens to app settings for future use
   * @public
   * @async
   * @param {string} email - User email address
   * @param {string} password - User password
   * @returns {Promise<boolean>} - Returns true if authentication successful
   * @throws {Error} If authentication fails
   * @example
   * try {
   *   const success = await app.authenticate('user@example.com', 'password123');
   *   if (success) {
   *     console.log('Authenticated successfully');
   *   }
   * } catch (error) {
   *   console.error('Authentication failed:', error.message);
   * }
   */
  async authenticate(email, password) {

    try {
      const device = new HonDevice('Homey-Hon');
      const debugEnabled = this.isDebugEnabled();

      this._auth = new HonAuth(null, email, password, device, debugEnabled);

      if (debugEnabled) {
        this.log('🐛 Debug mode ENABLED - JavahOn will output detailed logs');
      }

      // Register handler to save tokens
      this._registerTokenHandler();

      // Perform authentication
      await this._auth.authenticate();

      // Create API client
      this._api = new HonAPI(this._auth);

      this.log('Authentication successful');
      return true;
    } catch (error) {
      this.error('Authentication failed:', error.message);
      this._unregisterTokenHandler();
      this._auth = null;
      this._api = null;
      throw error;
    }
  }

  /**
   * Load translations from hOn API for current Homey language
   * Returns translations without caching - passed directly to devices
   * Public method shared by all device types (washing machines, dryers, ovens, etc.)
   * @public
   * @async
   * @returns {Promise<Object>} Translations object or empty object on error
   * @example
   * const translations = await app.loadTranslations();
   * appliance.extra.setTranslations(translations);
   */
  async loadTranslations() {
    if (!this._api) {
      this.log('⚠️  Cannot load translations: API not available');
      return {};
    }

    try {
      const homeyLanguage = this.homey.i18n.getLanguage();
      this.log(`📖 Loading translations for language: ${homeyLanguage}`);

      const translations = await this._api.getTranslations(homeyLanguage);
      const count = Object.keys(translations).length;
      this.log(`✅ Loaded ${count} translations from hOn API`);

      return translations;
    } catch (error) {
      this.error('Failed to load translations:', error.message);
      return {};
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PUBLIC API ACCESSORS
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Gets the authenticated API instance
   * @public
   * @returns {HonAPI|null} - API instance if authenticated, null otherwise
   * @example
   * const api = app.getApi();
   * if (api) {
   *   const appliances = await api.loadAppliances();
   * }
   */
  getApi() {
    return this._api;
  }

  /**
   * Gets the authentication instance
   * @public
   * @returns {HonAuth|null} - Auth instance if initialized, null otherwise
   * @example
   * const auth = app.getAuth();
   * if (auth) {
   *   const isValid = auth.validateTokens();
   * }
   */
  getAuth() {
    return this._auth;
  }

  /**
   * Get translation for a specific key from hOn API translations
   * Supports nested keys using dot notation (e.g., 'GLOBALS.APPLIANCE_STATUS.READY')
   * Returns the key itself if translation not found (graceful fallback)
   * @public
   * @param {string} key - Translation key (e.g., 'GLOBALS.APPLIANCE_STATUS.READY')
   * @returns {string} Translated text or key as fallback
   * @example
   * const state = app.getTranslation('GLOBALS.APPLIANCE_STATUS.READY');
   * // Returns: "Pronto" (if Italian) or "Ready" (if English)
   * 
   * const phase = app.getTranslation('WASHING_CMD&CTRL.PHASE_SPIN.TITLE');
   * // Returns: "Centrifuga" (if Italian) or "Spin" (if English)
   */
  // Translation methods removed - translations are now managed directly by JavahOn library
  // Devices call app._loadTranslations() to get fresh translations when needed

  /**
   * Checks if the app is currently authenticated with hOn servers
   * @public
   * @returns {boolean} - True if both auth and API are available
   * @example
   * if (app.isAuthenticated()) {
   *   console.log('User is logged in');
   * } else {
   *   console.log('User needs to authenticate');
   * }
   */
  isAuthenticated() {
    return this._auth !== null && this._api !== null;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PUBLIC APPLIANCE & MQTT MANAGEMENT
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Loads the list of all appliances from the hOn API
   * Caches the list in memory for future reference
   * @public
   * @async
   * @returns {Promise<Array>} - Array of appliance objects
   * @throws {Error} If not authenticated or API request fails
   * @example
   * try {
   *   const appliances = await app.loadAppliances();
   *   console.log(`Found ${appliances.length} appliances`);
   *   const washingMachines = appliances.filter(a => a.applianceType === 'WM');
   * } catch (error) {
   *   console.error('Failed to load appliances:', error.message);
   * }
   */
  async loadAppliances() {
    if (!this._api) {
      throw new Error('Not authenticated');
    }

    try {
      this.log('📋 loadAppliances() - Calling API...');
      this._appliances = await this._api.loadAppliances();
      this.log(`📋 loadAppliances() - Loaded ${this._appliances.length} appliance(s)`);

      if (this._appliances.length === 0) {
        this.error('⚠️  loadAppliances() - The API returned 0 appliances. Check the debug logs above for the raw API response.');
      } else {
        this._appliances.forEach((a, i) => {
          this.log(`📋   [${i}] type=${a.applianceTypeName || a.applianceType || '?'} | name=${a.nickName || a.modelName || '?'} | mac=${a.macAddress || a.serialNumber || '?'}`);
        });
      }

      return this._appliances;
    } catch (error) {
      this.error('Failed to load appliances:', error.message);
      if (error.response) {
        this.error(`  HTTP ${error.response.status} - ${error.response.config?.url || ''}`);
        this.error(`  Response: ${JSON.stringify(error.response.data).substring(0, 300)}`);
      }
      throw error;
    }
  }

  /**
   * Starts the MQTT client for real-time updates from appliances
   * Automatically disconnects any existing client before starting a new one
   * @public
   * @async
   * @param {Array<HonAppliance>} appliances - List of appliances to monitor via MQTT
   * @returns {Promise<MQTTClient>} - The started MQTT client instance
   * @throws {Error} If not authenticated or MQTT connection fails
   * @example
   * try {
   *   const appliances = await app.loadAppliances();
   *   const mqttClient = await app.startMqttClient(appliances);
   *   console.log('Real-time updates enabled');
   * } catch (error) {
   *   console.error('Failed to start MQTT:', error.message);
   * }
   */
  async startMqttClient(appliances) {
    if (!this._api) {
      throw new Error('Not authenticated');
    }

    // Disconnect existing client
    await this.stopMqttClient();

    try {
      this.log('Starting MQTT client for real-time updates...');
      this._mqttClient = await MQTTClient.create(this._api, appliances);

      // Setup message routing
      this._setupMqttRouting();

      this.log('MQTT client started successfully');
      return this._mqttClient;
    } catch (error) {
      this.error('Failed to start MQTT client:', error.message);
      throw error;
    }
  }

  /**
   * Stops the MQTT client and disconnects from the message broker
   * Safely handles cases where no client is running
   * @public
   * @async
   * @returns {Promise<void>}
   * @example
   * await app.stopMqttClient();
   * console.log('MQTT client stopped');
   */
  async stopMqttClient() {
    if (this._mqttClient) {
      try {
        await this._mqttClient.disconnect();
        this._mqttClient = null;
      } catch (error) {
        this.error('Error stopping MQTT client:', error.message);
      }
    }
  }

  /**
   * Gets the current MQTT client instance
   * @public
   * @returns {MQTTClient|null} - MQTT client if started, null otherwise
   * @example
   * const client = app.getMqttClient();
   * if (client) {
   *   console.log('MQTT is connected and running');
   * }
   */
  getMqttClient() {
    return this._mqttClient;
  }

  /**
   * Performs logout and cleans up all authentication and MQTT data
   * Removes saved tokens from app settings
   * @public
   * @async
   * @returns {Promise<void>}
   * @example
   * await app.logout();
   * console.log('User logged out, all data cleared');
   */
  async logout() {
    // Stop MQTT
    await this.stopMqttClient();

    // Remove token handler
    this._unregisterTokenHandler();

    // Clean up instances
    this._auth = null;
    this._api = null;
    this._appliances = [];

    // Remove saved data
    this.homey.settings.unset('honTokens');
  }

  // ═══════════════════════════════════════════════════════════════════════
  // HOMEY LIFECYCLE METHODS
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Called when the app is initialized
   * Restores previous authentication session if available
   * @public
   * @async
   * @returns {Promise<void>}
   * @example
   * // Called automatically by Homey when the app starts
   * // No manual invocation needed
   */
  async onInit() {
    this.log('onInit - App - hOn SmartHome App is initializing...');

    // Shared instances
    this._auth = null;
    this._api = null;
    this._mqttClient = null;
    this._tokenHandler = null;
    this._appliances = [];

    // Try to restore session from saved tokens
    await this._tryRestoreSession();

    this.log('hOn SmartHome App has been initialized');
  }


  /**
   * Called when the app is shutting down
   * Closes all connections and prevents memory leaks
   * @public
   * @async
   * @returns {Promise<void>}
   * @example
   * // Called automatically by Homey when the app stops
   * // No manual invocation needed
   */
  async onUninit() {
    this.log('hOn SmartHome App is shutting down...');

    // Stop MQTT
    await this.stopMqttClient();

    // Remove handlers to prevent memory leaks
    this._unregisterTokenHandler();

    this.log('hOn SmartHome App has been uninitialized');
  }

};
