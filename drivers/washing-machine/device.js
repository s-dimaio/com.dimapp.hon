'use strict';

const Homey = require('homey');
const { HonAppliance } = require('java-hon');

/**
 * Device class per le lavatrici hOn
 * Gestisce la comunicazione con l'appliance e gli aggiornamenti real-time via MQTT
 */
module.exports = class WashingMachineDevice extends Homey.Device {

  // ═══════════════════════════════════════════════════════════════════════
  // CAPABILITY MANAGEMENT & UPDATES
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Update capabilities from appliance parameters
   * Maps hOn API parameter values to Homey device capabilities
   * Updates state, program, temperature, time and other status fields
   * @private
   * @async
   * @param {Object} params - Parameter object from API or MQTT {machMode, prPhase, prCode, temp, etc}
   * @returns {Promise<void>}
   * @throws {Error} If capability update fails
   * @example
   * // Update capabilities from parameters
   * await this._updateCapabilitiesFromParams({
   *   machMode: '2',
   *   prPhase: '4',
   *   programName: 'Eco 40',
   *   remainingTimeMM: 45
   * });
   */
  async _updateCapabilitiesFromParams(params = {}) {
    this.log(`🔍 MQTT Params received:`, JSON.stringify(params, null, 2));

    try {
      // Get machMode from params or attributes
      // Handle both HonParameter objects {value: 'x'} and simple values
      let machMode = params.machMode !== undefined
        ? String(typeof params.machMode === 'object' && params.machMode.value !== undefined ? params.machMode.value : params.machMode)
        : null;
      if (!machMode && this._appliance?.attributes?.parameters?.machMode) {
        const storedMode = this._appliance.attributes.parameters.machMode;
        machMode = String(typeof storedMode === 'object' ? storedMode.value : storedMode);
      }

      // Determine if machine is idle/ready (not running a program)
      // NOTE: machMode 7 is excluded - it represents "finished" state and should keep program info
      const isIdle = machMode && ['0', '1'].includes(machMode);

      // Check if we're receiving program start parameters
      // These indicate a program is about to start or is starting
      const hasProgramParams = params.prCode !== undefined || params.temp !== undefined ||
        params.spinSpeed !== undefined || params.prPosition !== undefined;

      // If machine is idle AND we're NOT receiving program parameters, reset values
      // This prevents resetting when a program is starting (params arrive before machMode changes)
      if (isIdle && !hasProgramParams) {
        await this.setCapabilityValue('program_name', '-').catch(this.error);
        await this.setCapabilityValue('measure_remaining_time', 0).catch(this.error);
        await this.setCapabilityValue('wash_temperature', 0).catch(this.error);
        await this.setCapabilityValue('spin_speed', 0).catch(this.error);
      }

      // Get prPhase from params or attributes
      // Handle both HonParameter objects {value: 'x'} and simple values
      let prPhase = params.prPhase !== undefined
        ? String(typeof params.prPhase === 'object' && params.prPhase.value !== undefined ? params.prPhase.value : params.prPhase)
        : null;
      if (!prPhase && this._appliance?.attributes?.parameters?.prPhase) {
        const storedPhase = this._appliance.attributes.parameters.prPhase;
        prPhase = String(typeof storedPhase === 'object' ? storedPhase.value : storedPhase);
      }

      // Update state if we have machMode
      if (machMode) {
        let stateText = '';

        // Get localized state text from hOn API translations
        stateText = this._getLocalizedState(parseInt(machMode), parseInt(prPhase || 0));

        if (params.machMode !== undefined || params.prPhase !== undefined) {
          this.log(`State: ${stateText} (machMode=${machMode}, prPhase=${prPhase})`);
        }
        await this.setCapabilityValue('washer_job_state', stateText).catch(this.error);

        // Update washer_control to show it's always ready for commands
        await this.setCapabilityValue('washer_control', 'idle').catch(this.error);
      }

      // Update remaining time (in minutes) - only if machine is running
      if (!isIdle && params.remainingTimeMM !== undefined) {
        const remainingTime = parseInt(params.remainingTimeMM) || 0;
        await this.setCapabilityValue('measure_remaining_time', remainingTime).catch(this.error);
      }

      // Update program name if we have program information
      // Allow updates even when isIdle if we're receiving program params (program starting)
      if (params.prStr !== undefined || params.prCode !== undefined || params.prPosition !== undefined) {
        let programName = null;

        // Extract prCode and prPosition handling both HonParameter objects {value: 'x'} and simple values
        const prCode = params.prCode !== undefined
          ? String(typeof params.prCode === 'object' && params.prCode.value !== undefined ? params.prCode.value : params.prCode)
          : null;
        const prPosition = params.prPosition !== undefined
          ? String(typeof params.prPosition === 'object' && params.prPosition.value !== undefined ? params.prPosition.value : params.prPosition)
          : null;

        this.log(`🔍 PROGRAM LOOKUP - prCode=${prCode}, prPosition=${prPosition}, prStr=${params.prStr || 'not provided'}`);

        // STRATEGY 1: If MQTT provides prStr, use it as translation key
        if (params.prStr) {
          if (this._appliance?.extra) {
            programName = this._appliance.extra.getLocalizedProgramName(null, params.prStr);
            this.log(`✅ Localized program name from prStr: "${programName}" (key: ${params.prStr})`);
          } else {
            programName = params.prStr;
          }
        }
        // STRATEGY 2: If no prStr, use findProgramByCode
        else if (prCode !== null && prCode !== '0' && this._appliance?.extra) {
          const remoteEnabled = this.getCapabilityValue('remote_control_enabled') || false;

          const foundProgram = this._appliance.extra.findProgramByCode(
            parseInt(prCode),
            prPosition !== null ? parseInt(prPosition) : null,
            remoteEnabled
          );

          if (foundProgram) {
            // ✅ Use the already-localized name from findProgramByCode
            programName = foundProgram.name;
            this.log(`📋 Found program by code: name="${programName}", id="${foundProgram.id}", translationKey="${foundProgram.translationKey}", prCode=${prCode}, prPosition=${prPosition}, remote=${remoteEnabled ? 'ON' : 'OFF'}`);
          } else {
            this.log(`⚠️ Program not found with prCode=${prCode}, prPosition=${prPosition}`);
            programName = this.homey.__('program.fallback', { code: prCode });
          }
        }
        // STRATEGY 3: No program info available
        else if (prCode === '0' || prCode === null) {
          programName = '-'; // No program
        }

        // Final fallback
        if (!programName) {
          programName = this.homey.__('program.unknown');
        }

        await this.setCapabilityValue('program_name', programName).catch(this.error);
        // Also save in store for flow triggers (if program is running)
        if (programName && programName !== '-') {
          await this.setStoreValue('currentProgramName', programName);
        }
      }

      // NOTE: Power consumption (measure_power capability) has been removed
      // The hOn API does not expose real-time power consumption for this model
      // Only 'estimatedConsumption' (kWh per program) is available in lastActivity
      // Log estimated consumption if available (from attributes, not real-time)
      if (params.estimatedConsumption !== undefined) {
        this.log(`💡 Estimated program consumption: ${params.estimatedConsumption} kWh`);
      }

      // Update wash temperature if provided
      // Allow updates even when isIdle if we're receiving program params (program starting)
      if (params.temp !== undefined) {
        const temperature = parseInt(params.temp) || 0;
        await this.setCapabilityValue('wash_temperature', temperature).catch(this.error);
        // Also save in store for flow triggers
        await this.setStoreValue('currentTemp', temperature);
      }

      // Update spin speed if provided
      // Allow updates even when isIdle if we're receiving program params (program starting)
      if (params.spinSpeed !== undefined) {
        const spinSpeed = parseInt(params.spinSpeed) || 0;
        await this.setCapabilityValue('spin_speed', spinSpeed).catch(this.error);
        // Also save in store for flow triggers
        await this.setStoreValue('currentSpinSpeed', spinSpeed);
      }

      // Update remote control enabled status
      // NOTE: remoteCtrValid=1 means remote control is ENABLED in machine settings
      if (params.remoteCtrValid !== undefined) {
        const remoteEnabled = parseInt(params.remoteCtrValid) === 1;
        await this.setCapabilityValue('remote_control_enabled', remoteEnabled).catch(this.error);
        this.log(`📱 Remote control: ${remoteEnabled ? 'enabled (can send commands)' : 'disabled (cannot send commands)'}`);
      }
      // Note: Don't reset if not in MQTT payload - MQTT sends only changed values

      // Update delay time
      // NOTE: delayTime is in commands.startProgram, not in attributes when idle
      if (params.delayTime !== undefined) {
        const delayTime = parseInt(params.delayTime) || 0;
        await this.setCapabilityValue('delay_time', delayTime).catch(this.error);
        if (delayTime > 0) {
          this.log(`⏲️  Delay time: ${delayTime} minutes`);
        } else {
          this.log(`⏲️  Delay time: 0 minutes (no delay programmed)`)
        }
      }
      // Note: Don't reset if not in MQTT payload - MQTT sends only changed values

    } catch (error) {
      this.error('Error updating capabilities:', error.message);
    }
  }

  /**
   * Get localized state text from machine mode and phase
   * Delegates to JavahOn library for translation logic
   * Uses hOn API translations with fallback to formatted phase key
   * @private
   * @param {number} machMode - Machine mode value (0=idle, 2=running, etc.)
   * @param {number} prPhase - Program phase value (0=idle, 11=spin, etc.)
   * @returns {string} Localized state text
   * @example
   * const state = this._getLocalizedState(2, 11);
   * // Returns: "Centrifuga" (if Italian) or "Spin" (if English)
   * 
   * const state = this._getLocalizedState(0, 0);
   * // Returns: "Pronto" (if Italian) or "Ready" (if English)
   */
  _getLocalizedState(machMode, prPhase) {
    if (!this._appliance?.extra) return 'Unknown';

    return this._appliance.extra.getLocalizedState(machMode, prPhase);
  }


  /**
   * Update all device capabilities from current appliance data
   * Synchronizes all Homey capabilities with appliance parameters
   * @private
   * @async
   * @returns {Promise<void>}
   * @throws {Error} If capability update fails
   * @example
   * // Update all capabilities from appliance state
   * await this._updateCapabilities();
   * // All Homey capabilities now match appliance parameters
   */
  async _updateCapabilities() {
    if (!this._appliance || !this._appliance.attributes) {
      this.log('⚠️  Cannot update capabilities: appliance or attributes missing');
      return;
    }

    // Update connection status capability
    const isOnline = this._appliance.connection;
    await this.setCapabilityValue('connection_status', isOnline ? 'Online' : 'Offline').catch(this.error);

    // Log connection status
    this.log(`📡 Connection status: ${isOnline ? '✅ ONLINE' : '❌ OFFLINE'}`);

    // Also check lastConnEvent if available
    if (this._appliance.attributes.lastConnEvent) {
      const lastConn = this._appliance.attributes.lastConnEvent;
      this.log(`   Last connection event: category="${lastConn.category}", timestamp="${lastConn.timestamp || 'N/A'}"`);
    }

    const params = this._appliance.attributes.parameters || {};

    this.log(`🔍 _updateCapabilities - Found ${Object.keys(params).length} parameters in attributes`);

    // Converte i parametri HonParameter in valori semplici
    const simpleParams = {};
    for (const [key, param] of Object.entries(params)) {
      simpleParams[key] = typeof param === 'object' && param.value !== undefined
        ? param.value
        : param;
    }

    this.log(`🔍 Converted to simple params:`, JSON.stringify(simpleParams, null, 2));

    await this._updateCapabilitiesFromParams(simpleParams);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // COMMAND VALIDATION & HELPERS
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Validate device is ready to execute commands
   * Checks both connection status and remote control enabled
   * @private
   * @returns {void}
   * @throws {Error} With localized error message if device not ready
   * @example
   * // Check device before executing command
   * this._validateDeviceReady();
   * // Throws error if device offline or remote control disabled
   */
  _validateDeviceReady() {
    // Check connection status
    const connectionStatus = this.getCapabilityValue('connection_status');
    if (connectionStatus !== 'online') {
      throw new Error(this.homey.__('errors.device_offline') || 'La lavatrice è offline. Assicurati che sia accesa e connessa.');
    }

    // Check remote control is enabled
    const remoteEnabled = this.getCapabilityValue('remote_control_enabled');
    if (!remoteEnabled) {
      throw new Error(this.homey.__('errors.remote_control_disabled') || 'Il controllo remoto non è abilitato. Abilitalo sul display della lavatrice.');
    }
  }



  // ═══════════════════════════════════════════════════════════════════════
  // COMMAND EXECUTION
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Start a wash program with specified parameters
   * Validates device readiness, sets command parameters, and sends to API
   * @private
   * @async
   * @param {string} programId - Program ID (e.g., 'rapid_14_min', 'perfect_cotton_59')
   * @param {number} [temperature=30] - Temperature in °C
   * @param {number} [spinSpeed=1000] - Spin speed in rpm
   * @param {Object} [options] - Additional start options
   * @param {number} options.delayTime - Delay before program starts (minutes)
   * @param {boolean} options.extraRinse - Enable extra rinse if supported
   * @returns {Promise<boolean>} True if command sent successfully
   * @throws {Error} If device not ready or command fails
   * @example
   * // Start rapid 14 min program at 30°C with 1000 rpm spin
   * const success = await this._startProgram('rapid_14_min', 30, 1000);
   * // Or with delay time
   * const success = await this._startProgram('perfect_cotton_59', 40, 800, { delayTime: 30 });
   */
  async _startProgram(programId, temperature = 30, spinSpeed = 1000, options = {}) {
    try {
      this.log(`🚀 Starting program: id=${programId}, temp=${temperature}°C, spin=${spinSpeed}rpm`);

      // Validate device is ready (online + remote control enabled)
      this._validateDeviceReady();

      if (!this._appliance || !this._appliance.commands || !this._appliance.commands.startProgram) {
        throw new Error('Start program command not available');
      }

      // Get the command object
      const startCmd = this._appliance.commands.startProgram;

      // Prepare parameters to send
      const params = {
        program: programId,
        temp: String(temperature),
        spinSpeed: String(spinSpeed)
      };

      // Add optional parameters
      if (options.delayTime !== undefined) {
        params.delayTime = options.delayTime;
      }

      if (options.extraRinse) {
        params.extraRinse1 = 1;
      }

      this.log(`📋 Sending command with params:`, params);

      // Send the command using the library's send() method with parameters
      // This will auto-complete parameters and return detailed program information
      const result = await startCmd.send(params);

      if (result.success) {
        this.log('✅ Program started successfully');

        // Use the program information returned by send() - no need to call getAvailablePrograms()
        const programName = result.programName;  // Already localized by the library

        this.log(`📋 Program info from send(): name="${programName}", temp=${result.parameters.temp}°C, spin=${result.parameters.spinSpeed}rpm`);

        // Update capabilities immediately with the values from the result
        //TODO: Check if this is needed
        await this.setCapabilityValue('program_name', programName).catch(this.error);
        await this.setCapabilityValue('wash_temperature', temperature).catch(this.error);
        await this.setCapabilityValue('spin_speed', spinSpeed).catch(this.error);

        this.log(`📋 Capabilities updated: program="${programName}", temp=${temperature}°C, spin=${spinSpeed}rpm`);

        // Note: washer_job_state will be updated via MQTT
      } else {
        this.error('❌ Failed to start program:', result.error || 'Unknown error');
      }

      return result.success;

    } catch (error) {
      this.error('Error starting program:', error.message);
      throw error;
    }
  }

  /**
   * Pause the currently running wash program
   * Can only be called when program is running and device is ready
   * @private
   * @async
   * @returns {Promise<boolean>} True if pause command sent successfully
   * @throws {Error} If device not ready or pause command not available
   * @example
   * // Pause currently running program
   * const success = await this._pauseProgram();
   */
  async _pauseProgram() {
    try {
      this.log('⏸️ Pausing program...');

      // Validate device is ready (online + remote control enabled)
      this._validateDeviceReady();

      if (!this._appliance || !this._appliance.commands || !this._appliance.commands.pauseProgram) {
        throw new Error('Pause command not available');
      }

      const result = await this._appliance.commands.pauseProgram.send();
      this.log('✅ Program paused successfully');
      return true;

    } catch (error) {
      this.error('Error pausing program:', error.message);
      throw error;
    }
  }

  /**
   * Resume the paused wash program
   * Can only be called when program is paused and device is ready
   * @private
   * @async
   * @returns {Promise<boolean>} True if resume command sent successfully
   * @throws {Error} If device not ready or resume command not available
   * @example
   * // Resume paused program
   * const success = await this._resumeProgram();
   */
  async _resumeProgram() {
    try {
      this.log('▶️ Resuming program...');

      // Validate device is ready (online + remote control enabled)
      this._validateDeviceReady();

      if (!this._appliance || !this._appliance.commands || !this._appliance.commands.resumeProgram) {
        throw new Error('Resume command not available');
      }

      const result = await this._appliance.commands.resumeProgram.send();
      this.log('✅ Program resumed successfully');
      return true;

    } catch (error) {
      this.error('Error resuming program:', error.message);
      throw error;
    }
  }

  /**
   * Stop the currently running wash program
   * Can only be called when program is running and device is ready
   * @private
   * @async
   * @returns {Promise<boolean>} True if stop command sent successfully
   * @throws {Error} If device not ready or stop command not available
   * @example
   * // Stop currently running program
   * const success = await this._stopProgram();
   */
  async _stopProgram() {
    try {
      this.log('⏹️ Stopping program...');

      // Validate device is ready (online + remote control enabled)
      this._validateDeviceReady();

      if (!this._appliance || !this._appliance.commands || !this._appliance.commands.stopProgram) {
        throw new Error('Stop command not available');
      }

      const result = await this._appliance.commands.stopProgram.send();
      this.log('✅ Program stopped successfully');
      return true;

    } catch (error) {
      this.error('Error stopping program:', error.message);
      throw error;
    }
  }


  // ═══════════════════════════════════════════════════════════════════════
  // POLLING & BACKGROUND UPDATES
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Start backup polling of appliance status
   * Adaptive polling: only active when MQTT is disconnected
   * Polls every 10 minutes to ensure data is current if MQTT fails
   * @private
   * @returns {void}
   * @example
   * // Start polling for status updates
   * this._startPolling();
   * // Appliance status will be checked every 10 minutes
   */
  _startPolling() {
    // Ferma polling esistente
    this._stopPolling();

    // Check if MQTT is active
    const mqttClient = this.homey.app.getMqttClient();
    if (mqttClient && mqttClient.isConnected()) {
      this.log('⏭️  Polling skipped - MQTT is active');
      return;
    }

    this.log('🔄 Starting adaptive polling (MQTT inactive)');

    // Poll ogni 10 minuti
    this._pollInterval = this.homey.setInterval(async () => {
      try {
        if (this._appliance) {
          // Double-check MQTT status before polling
          const mqtt = this.homey.app.getMqttClient();
          if (mqtt && mqtt.isConnected()) {
            this.log('⏹️  Stopping polling - MQTT reconnected');
            this._stopPolling();
            return;
          }

          // Attributes are already loaded by loadAppliances()
          // Just update capabilities with current state
          await this._updateCapabilities();
        }
      } catch (error) {
        this.error('Polling error:', error.message);
      }
    }, 10 * 60 * 1000); // 10 minuti
  }

  /**
   * Stop backup polling of appliance status
   * Clears polling interval to free resources
   * @private
   * @returns {void}
   * @example
   * // Stop polling for status updates
   * this._stopPolling();
   * // Polling interval is cleared and memory freed
   */
  _stopPolling() {
    if (this._pollInterval) {
      this.homey.clearInterval(this._pollInterval);
      this._pollInterval = null;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // MQTT SETUP & REGISTRATION
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Register MQTT event handlers for device connection monitoring and parameter updates
   * Listens to appliance-specific connection events, MQTT broker status, and parameter updates
   * Connection status and capabilities are updated in real-time from MQTT messages
   * @private
   * @returns {void}
   * @example
   * // Set up MQTT handlers for device
   * this._setupMqttHandlers();
   * // Device will monitor appliance connectivity and receive real-time parameter updates
   */
  _setupMqttHandlers() {
    const macAddress = this.getStoreValue('macAddress');
    this.log('Setting up MQTT handlers...');

    // Handler for appliance connection changes (online/offline)
    this._connectionHandler = (connected) => {
      this.log(`📡 Appliance ${connected ? 'online' : 'offline'} (MQTT event)`);
      this.setCapabilityValue('connection_status', connected ? 'online' : 'offline').catch(this.error);
    };

    // Handler for MQTT disconnection
    this._disconnectedHandler = () => {
      this.log('⚠️ MQTT disconnected, device may not receive real-time updates');
      this.setWarning('MQTT disconnected').catch(this.error);

      // Start adaptive polling as backup
      this.log('🔄 Activating adaptive polling as backup');
      this._startPolling();
    };

    // Handler for MQTT reconnection
    this._connectedHandler = () => {
      this.log('✅ MQTT reconnected, resuming real-time updates');
      this.unsetWarning().catch(this.error);

      // Stop adaptive polling when MQTT is back
      this.log('⏹️  Deactivating adaptive polling (MQTT active)');
      this._stopPolling();
    };

    // Register handlers
    this.homey.app.on(`mqtt:connection:${macAddress}`, this._connectionHandler);
    this.homey.app.on('mqtt:disconnected', this._disconnectedHandler);
    this.homey.app.on('mqtt:connected', this._connectedHandler);
    // NOTE: Parameter updates are received via the 'attributesUpdated' event from the
    // JavahOn library (see _setupLibraryEventListeners), which already filters by MAC
    // address internally. A separate 'mqtt:update:{mac}' handler here would cause
    // _updateCapabilitiesFromParams() to be called twice per MQTT message.

    this.log('✅ MQTT handlers setup complete');
  }

  /**
   * Unregister MQTT event handlers to prevent memory leaks
   * Removes appliance connection listeners and global MQTT broker listeners
   * @private
   * @returns {void}
   * @example
   * // Clean up MQTT handlers
   * this._unregisterMqttHandlers();
   * // All MQTT event listeners are removed
   */
  _unregisterMqttHandlers() {
    const macAddress = this.getStoreValue('macAddress');
    this.log('Cleaning up MQTT handlers...');

    if (this._connectionHandler) {
      this.homey.app.removeListener(`mqtt:connection:${macAddress}`, this._connectionHandler);
      this._connectionHandler = null;
    }

    if (this._disconnectedHandler) {
      this.homey.app.removeListener('mqtt:disconnected', this._disconnectedHandler);
      this._disconnectedHandler = null;
    }

    if (this._connectedHandler) {
      this.homey.app.removeListener('mqtt:connected', this._connectedHandler);
      this._connectedHandler = null;
    }

    this.log('✅ MQTT handlers cleaned up');

    // Also cleanup library event listeners
    this._unregisterLibraryEventListeners();
  }

  // ═══════════════════════════════════════════════════════════════════════
  // DEVICE INITIALIZATION & SETUP
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Initialize device by loading appliance data from API
   * Loads commands, attributes, programs, and starts MQTT and polling
   * @private
   * @async
   * @returns {Promise<void>}
   * @throws {Error} If appliance not found or API fails
   * @example
   * // Internal initialization called from onInit()
   * // Loads all appliance data and sets up real-time updates
   */
  async _initializeDevice() {
    try {
      const app = this.homey.app;

      if (!app.isAuthenticated()) {
        this.log('App not authenticated, waiting...');
        this.setUnavailable(this.homey.__('device.not_authenticated') || 'Not authenticated');
        return;
      }

      // Carica appliances
      const appliances = await app.loadAppliances();
      const macAddress = this.getStoreValue('macAddress');

      // Trova l'appliance corrispondente
      const applianceData = appliances.find(a =>
        (a.macAddress || a.serialNumber) === macAddress
      );

      if (!applianceData) {
        this.error('Appliance not found:', macAddress);
        this.setUnavailable(this.homey.__('device.not_found') || 'Device not found');
        return;
      }

      // Crea oggetto appliance
      this._appliance = new HonAppliance(app.getApi(), applianceData);

      // 🔍 Check if attributes are already present in applianceData
      this.log('🔍 Appliance created - checking initial data...');
      if (applianceData.attributes) {
        this.log(`   applianceData.attributes exists: ${Object.keys(applianceData.attributes).length} root keys`);
        if (applianceData.attributes.parameters) {
          this.log(`   applianceData.attributes.parameters: ${Object.keys(applianceData.attributes.parameters).length} params`);
        }
      } else {
        this.log('   applianceData.attributes: NOT PRESENT');
      }

      // Carica comandi e attributi
      this.log('📥 Loading commands...');
      this.log('🔍 Before loadCommands() call');

      try {
        await this._appliance.loadCommands();
      } catch (loadCmdError) {
        this.error('❌ loadCommands() threw error:', loadCmdError.message);
        this.error('Stack trace:', loadCmdError.stack);
        throw loadCmdError;
      }

      this.log('🔍 After loadCommands() call - checking results...');
      this.log('Commands loaded:', Object.keys(this._appliance.commands || {}).length);
      this.log('Command names:', Object.keys(this._appliance.commands || {}));
      this.log('✅ Commands loaded');

      // Set translations on appliance for program name localization
      if (this._appliance.extra) {
        const translations = await app.loadTranslations();
        this._appliance.extra.setTranslations(translations);
        this.log('✅ Translations set on appliance');
      }

      // Log available programs, temperatures and spin speeds
      const programs = this.getAvailablePrograms();
      const temperatures = this.getAvailableTemperatures();
      const spinSpeeds = this.getAvailableSpinSpeeds();

      this.log('📋 Available programs:', programs.length);
      this.log('   Programs:', programs.map(p => `${p.name} (prCode=${p.prCode} - prPosition=${p.prPosition})`).join(', '));
      this.log('🌡️  Available temperatures:', temperatures.join('°C, ') + '°C');
      this.log('🔄 Available spin speeds:', spinSpeeds.join(', ') + ' rpm');

      // Fetch fresh initial state from API to ensure complete data
      // This is crucial when app starts with a cycle already in progress
      // MQTT only sends changed parameters, so initial state might be incomplete
      this.log('📥 Fetching initial appliance state from API...');
      try {
        await this._appliance.loadAttributes(); // Reload fresh attributes from API
        this.log('✅ Fresh attributes loaded from API');

        // Log initial state for debugging
        const params = this._appliance.attributes?.parameters || {};

        this.log('Parametri restituiti dall\'API:', Object.keys(params));
        // Se vuoi vedere anche i valori:
        this.log('Dettaglio parametri:', JSON.stringify(params, null, 2));

        const machMode = typeof params.machMode === 'object' ? params.machMode.value : params.machMode;
        const prCode = typeof params.prCode === 'object' ? params.prCode.value : params.prCode;
        const prPosition = typeof params.prPosition === 'object' ? params.prPosition.value : params.prPosition;
        const programName = typeof params.programName === 'object' ? params.programName.value : params.programName;
        const temp = typeof params.temp === 'object' ? params.temp.value : params.temp;
        const spinSpeed = typeof params.spinSpeed === 'object' ? params.spinSpeed.value : params.spinSpeed;
        const remainingTime = typeof params.remainingTimeMM === 'object' ? params.remainingTimeMM.value : params.remainingTimeMM;

        this.log(`   📊 Initial state from API:`);
        this.log(`      machMode=${machMode}, prPhase=${params.prPhase ? (typeof params.prPhase === 'object' ? params.prPhase.value : params.prPhase) : 'N/A'}`);
        this.log(`      prCode=${prCode}, prPosition=${prPosition}`);
        this.log(`      programName=${programName || 'N/A'}`);
        this.log(`      temp=${temp}°C, spin=${spinSpeed}rpm, remaining=${remainingTime}min`);

      } catch (attrError) {
        this.log('⚠️  Could not load fresh attributes:', attrError.message);
        this.log('   Stack:', attrError.stack);
        // Continue with cached attributes - not critical
      }

      // Aggiorna capabilities con i dati iniziali (now fresh from API)
      this.log('📥 Updating capabilities with initial state...');
      await this._updateCapabilities();
      this.log('✅ Capabilities updated');

      // Check if machine is running but program details are missing (manual wash)
      // In this case, ensure the UI shows the correct state
      // Note: We use the just-loaded attributes from API
      // Check if machine is running but program details are missing (manual wash)
      // In this case, ensure the UI shows the correct state
      // Note: We use the just-loaded attributes from API
      const params = this._appliance.attributes?.parameters || {};

      // Helper to safely extract value
      const getVal = (p) => (p && typeof p === 'object' && 'value' in p) ? p.value : p;

      const currentMachMode = getVal(params.machMode);
      const currentPrCode = getVal(params.prCode);
      const currentProgramName = getVal(params.programName);

      this.log(`🔍 DEBUG: Checking manual wash condition:`);
      this.log(`   - machMode: ${currentMachMode} (type: ${typeof currentMachMode})`);
      this.log(`   - prCode: ${currentPrCode} (type: ${typeof currentPrCode})`);
      this.log(`   - programName: ${currentProgramName}`);

      // Manual Wash Logic:
      // machMode must be '2' (Running)
      // prCode usually '0' or missing on manual wash
      // Also check if prCode is just empty string
      const isRunning = String(currentMachMode) === '2';
      const isManualProgram = !currentPrCode || String(currentPrCode) === '0' || String(currentPrCode) === '';

      if (isRunning && isManualProgram) {
        this.log('🔍 DETECTED MANUAL WASH IN PROGRESS (Condition Met)');

        // Force update of state text as well, in case _updateCapabilities mistook it for something else
        const prPhaseVal = parseInt(getVal(params.prPhase) || 0);
        const stateText = this._getLocalizedState(2, prPhaseVal);
        await this.setCapabilityValue('washer_job_state', stateText).catch(this.error);

        this.log(`   -> Forcing state to: "${stateText}" (machMode=2, prPhase=${prPhaseVal})`);
        this.log('   Program details not available for manual washes started on the machine');

        // Set program name to indicate manual wash
        const manualWashLabel = this.homey.__('device.manual_wash') || 'Manual wash';
        await this.setCapabilityValue('program_name', manualWashLabel).catch(this.error);

        // Update remaining time if available
        const remainingTime = parseInt(getVal(params.remainingTimeMM) || 0);

        if (remainingTime > 0) {
          this.log(`   -> Updating remaining time: ${remainingTime} min`);
          await this.setCapabilityValue('measure_remaining_time', remainingTime).catch(this.error);
        }

        this.log(`   Set program_name="${manualWashLabel}", remainingTime=${remainingTime}min`);
      } else {
        this.log('ℹ️ Manual wash check: Not a manual wash or not running.');
      }

      // Inizializza MQTT per updates real-time
      await this.initializeMqtt();

      // Setup JavahOn library event listeners
      this._setupLibraryEventListeners();

      // Adaptive polling: will start only if MQTT fails to connect
      this._startPolling();

      this.setAvailable();
      this.log('Device fully initialized');

    } catch (error) {
      this.error('Failed to initialize device:', error.message);
      this.setUnavailable(this.homey.__('device.init_failed') || `Initialization failed: ${error.message}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // JAVAHON LIBRARY EVENT LISTENERS
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Setup JavahOn library event listeners for washing machine state changes
   * Listens to programStarted and programFinished events from WashingMachine class
   * @private
   * @returns {void}
   * @example
   * // Set up library event listeners
   * this._setupLibraryEventListeners();
   * // Device will react to events emitted by JavahOn WashingMachine
   */
  _setupLibraryEventListeners() {
    if (!this._appliance?.extra) {
      this.error('Cannot setup library event listeners: appliance.extra not available');
      return;
    }

    this.log('Setting up JavahOn library event listeners...');

    // Listen to attributesUpdated event from JavahOn for real-time capability updates
    this._attributesUpdatedHandler = async (params) => {
      this.log(`🎯 ATTRIBUTES UPDATED (from JavahOn event) - Updating capabilities`);

      // When MQTT message arrives, device is implicitly online
      // Update connection status to online if it was offline
      const currentStatus = this.getCapabilityValue('connection_status');
      if (currentStatus !== 'online') {
        this.log('📡 Device online (MQTT message received)');
        await this.setCapabilityValue('connection_status', 'online').catch(this.error);
      }

      await this._updateCapabilitiesFromParams(params);
    };

    // Listen to programStarted event from JavahOn
    this._programStartedHandler = async (event) => {
      this.log('🎯 WASH STARTED (from JavahOn event) - Triggering flow');

      // Store wash start time
      await this.setStoreValue('washStartTime', event.timestamp);

      // Check if remote control is disabled (manual wash started on machine)
      // In this case, MQTT only sends partial updates, so we need to fetch full state from API
      const remoteEnabled = this.getCapabilityValue('remote_control_enabled');
      if (!remoteEnabled) {
        this.log('📱 Remote control disabled - Manual wash detected, fetching full state from API...');
        try {
          // Reload fresh attributes from API to get complete program info
          await this._appliance.loadAttributes();
          this.log('✅ Fresh attributes loaded from API');

          // Update capabilities with fresh data
          await this._updateCapabilities();
          this.log('✅ Capabilities updated with fresh API data');
        } catch (apiError) {
          this.error('⚠️ Failed to fetch fresh state from API:', apiError.message);
          // Continue with cached values - not critical for flow trigger
        }
      }

      // Get values from capabilities (now possibly updated from API)
      const programName = this.getCapabilityValue('program_name')
        || this.getStoreValue('currentProgramName')
        || '-';
      const temperature = this.getCapabilityValue('wash_temperature')
        || this.getStoreValue('currentTemp')
        || 0;
      const spinSpeed = this.getCapabilityValue('spin_speed')
        || this.getStoreValue('currentSpinSpeed')
        || 0;

      this.log(`   Token values: program="${programName}", temp=${temperature}, spin=${spinSpeed}`);

      this._washStartedTrigger.trigger(this, {
        program: programName,
        temperature: temperature,
        spin_speed: spinSpeed
      }).catch(err => this.error('Failed to trigger wash_started:', err));
    };

    // Listen to programFinished event from JavahOn
    this._programFinishedHandler = async (event) => {
      this.log('🎯 WASH FINISHED (from JavahOn event) - Triggering flow');

      // Get values from capabilities
      const programName = this.getCapabilityValue('program_name')
        || this.getStoreValue('currentProgramName')
        || '-';

      // Calculate duration from stored start time
      const startTime = this.getStoreValue('washStartTime');
      const totalTime = startTime
        ? Math.round((event.timestamp - startTime) / 60000)
        : 0;

      this.log(`   Token values: program="${programName}", duration=${totalTime} min`);

      this._washFinishedTrigger.trigger(this, {
        program: programName,
        duration: totalTime
      }).catch(err => this.error('Failed to trigger wash_finished:', err));

      // Clear stored values
      await this.setStoreValue('washStartTime', null);
    };

    // Register event handlers on WashingMachine instance
    this._appliance.extra.on('programStarted', this._programStartedHandler);
    this._appliance.extra.on('programFinished', this._programFinishedHandler);
    this._appliance.extra.on('attributesUpdated', this._attributesUpdatedHandler);

    this.log('✅ JavahOn library event listeners setup complete');
  }

  /**
   * Unregister JavahOn library event listeners to prevent memory leaks
   * @private
   * @returns {void}
   * @example
   * // Clean up library event listeners
   * this._unregisterLibraryEventListeners();
   * // All event listeners for JavahOn events are removed
   */
  _unregisterLibraryEventListeners() {
    if (!this._appliance?.extra) return;

    this.log('Cleaning up JavahOn library event listeners...');

    if (this._programStartedHandler) {
      this._appliance.extra.removeListener('programStarted', this._programStartedHandler);
      this._programStartedHandler = null;
    }

    if (this._programFinishedHandler) {
      this._appliance.extra.removeListener('programFinished', this._programFinishedHandler);
      this._programFinishedHandler = null;
    }

    if (this._attributesUpdatedHandler) {
      this._appliance.extra.removeListener('attributesUpdated', this._attributesUpdatedHandler);
      this._attributesUpdatedHandler = null;
    }

    this.log('✅ JavahOn library event listeners cleaned up');
  }

  // ═══════════════════════════════════════════════════════════════════════
  // CAPABILITY LISTENERS & FLOW CARDS
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Register listeners for device capability changes
   * Handles user control through washer_control capability
   * @private
   * @returns {void}
   * @example
   * // Register capability listeners for user interactions
   * this._registerCapabilityListeners();
   * // Device will respond to pause/resume/stop commands
   */
  _registerCapabilityListeners() {
    // Register washer_control capability listener
    this.registerCapabilityListener('washer_control', async (value) => {
      this.log(`Washer control command: ${value}`);

      // Execute command based on selected value
      switch (value) {
        case 'pause':
          await this._pauseProgram();
          break;
        case 'resume':
          await this._resumeProgram();
          break;
        case 'stop':
          await this._stopProgram();
          break;
        case 'idle':
          // No action needed, just display state
          break;
        default:
          throw new Error(`Unknown control command: ${value}`);
      }

      // Reset to idle after command execution (except if already idle)
      if (value !== 'idle') {
        await this.setCapabilityValue('washer_control', 'idle').catch(this.error);
      }

      return true;
    });
  }

  /**
   * Register flow card actions for automation
   * Sets up flow triggers and action handlers for start/pause/resume/stop
   * @private
   * @returns {void}
   * @example
   * // Register flow card handlers
   * this._registerFlowCardActions();
   * // Flow cards can now trigger washing machine commands
   */
  _registerFlowCardActions() {
    // ═══════════════════════════════════════════════════════════════════
    // FLOW TRIGGERS
    // ═══════════════════════════════════════════════════════════════════

    // Store trigger cards for later use
    this._washStartedTrigger = this.homey.flow.getDeviceTriggerCard('wash_started');
    this._washFinishedTrigger = this.homey.flow.getDeviceTriggerCard('wash_finished');

    // ═══════════════════════════════════════════════════════════════════
    // FLOW ACTIONS
    // ═══════════════════════════════════════════════════════════════════

    // Start program action with autocomplete
    const startProgramCard = this.homey.flow.getActionCard('start_program');

    // Register autocomplete for program
    startProgramCard.registerArgumentAutocompleteListener('program', async (query, args) => {
      const programs = this.getAvailablePrograms();

      return programs
        .filter(p => p.name.toLowerCase().includes(query.toLowerCase()))
        .map(p => {
          // Build description with temperature and spin speed
          const tempStr = p.temp !== null ? `${p.temp}°C` : '-';
          const spinStr = p.spinSpeed !== null ? `${p.spinSpeed} rpm` : '-';

          return {
            name: p.name, // Already translated by getAvailablePrograms()
            description: `${tempStr} • ${spinStr}`,
            id: p.id, // ✅ Use program ID, not prCode
            // Store temp and spin for potential future use
            temp: p.temp,
            spinSpeed: p.spinSpeed
          };
        });
    });

    // Register autocomplete for temperature
    startProgramCard.registerArgumentAutocompleteListener('temperature', async (query, args) => {
      const temperatures = this.getAvailableTemperatures();
      return temperatures
        .filter(t => String(t).includes(query))
        .map(t => ({
          name: t === 0 ? this.homey.__('temperature.cold') : `${t}°C`,
          id: String(t)
        }));
    });

    // Register autocomplete for spin speed
    startProgramCard.registerArgumentAutocompleteListener('spin_speed', async (query, args) => {
      const spinSpeeds = this.getAvailableSpinSpeeds();
      return spinSpeeds
        .filter(s => String(s).includes(query))
        .map(s => ({
          name: s === 0 ? this.homey.__('spin.no_spin') : `${s} rpm`,
          id: String(s)
        }));
    });

    // Register run listener
    startProgramCard.registerRunListener(async (args, state) => {
      this.log('Flow action: start_program', args);

      const program = args.program.id;
      const temperature = parseInt(args.temperature.id);
      const spinSpeed = parseInt(args.spin_speed.id);

      return await this._startProgram(program, temperature, spinSpeed);
    });

    // Pause program action
    this.homey.flow.getActionCard('pause_program')
      .registerRunListener(async (args, state) => {
        this.log('Flow action: pause_program');
        return await this._pauseProgram();
      });

    // Resume program action
    this.homey.flow.getActionCard('resume_program')
      .registerRunListener(async (args, state) => {
        this.log('Flow action: resume_program');
        return await this._resumeProgram();
      });

    // Stop program action
    this.homey.flow.getActionCard('stop_program')
      .registerRunListener(async (args, state) => {
        this.log('Flow action: stop_program');
        return await this._stopProgram();
      });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PUBLIC DATA ACCESSORS
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Get list of available wash programs for this washing machine
   * Uses JavahOn library to extract program info from appliance data
   * Programs are automatically localized using translations set on the appliance
   * @public
   * @returns {Array<Object>} Array of program objects with {id, name, prCode, prPosition}
   * @example
   * // Get available programs
   * const programs = this.getAvailablePrograms();
   * // Returns: [
   * //   { name: 'Eco 40', prCode: '0', prPosition: '0' },
   * //   { name: 'Delicate 30', prCode: '1', prPosition: '0' },
   * //   ...
   * // ]
   */
  getAvailablePrograms() {
    if (!this._appliance?.extra) return [];

    // Use JavahOn library method - translations already set on appliance
    return this._appliance.extra.getAvailablePrograms();
  }

  /**
   * Get list of available temperatures for the washing machine
   * Uses JavahOn library to extract temperature options
   * @public
   * @returns {Array<number>} Array of supported temperatures in °C (e.g. [20, 30, 40, 60, 90])
   * @example
   * // Get available temperatures
   * const temps = this.getAvailableTemperatures();
   * // Returns: [20, 30, 40, 60, 90]
   */
  getAvailableTemperatures() {
    if (!this._appliance?.extra) return [];

    // Use JavahOn library method
    return this._appliance.extra.getAvailableTemperatures();
  }

  /**
   * Get list of available spin speeds for the washing machine
   * Uses JavahOn library to extract spin speed options
   * @public
   * @returns {Array<number>} Array of supported spin speeds in rpm (e.g. [0, 400, 600, 800, 1000, 1200, 1400])
   * @example
   * // Get available spin speeds
   * const speeds = this.getAvailableSpinSpeeds();
   * // Returns: [0, 400, 600, 800, 1000, 1200, 1400]
   */
  getAvailableSpinSpeeds() {
    if (!this._appliance?.extra) return [];

    // Use JavahOn library method
    return this._appliance.extra.getAvailableSpinSpeeds();
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PUBLIC MQTT INITIALIZATION & REPAIR
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Initialize MQTT client for real-time appliance updates
   * Sets up device-specific MQTT handlers for this washing machine
   * @public
   * @async
   * @returns {Promise<void>}
   * @example
   * // Initialize MQTT for real-time status updates
   * await this.initializeMqtt();
   * // Device will now receive real-time updates via MQTT
   */
  async initializeMqtt() {
    try {
      const app = this.homey.app;

      if (!app.isAuthenticated() || !this._appliance) {
        return;
      }

      // Rimuovi handler precedenti
      this._unregisterMqttHandlers();

      // Ottieni o avvia il client MQTT
      let mqttClient = app.getMqttClient();

      if (!mqttClient) {
        // Only subscribe to devices actually added in Homey
        // IMPORTANT: Reuse the existing HonAppliance instances from each device
        // so that MQTT updates emit events on the SAME objects that devices listen to.
        // Creating new HonAppliance objects would break the event chain because
        // each HonAppliance creates its own WashingMachine (.extra) with its own EventEmitter.
        const driver = this.driver;
        const devices = driver.getDevices();
        const honAppliances = devices
          .filter(d => d._appliance)
          .map(d => d._appliance);

        this.log(`Starting MQTT for ${honAppliances.length} registered device(s)`);
        mqttClient = await app.startMqttClient(honAppliances);
      }

      if (!mqttClient) {
        this.log('MQTT client not available');
        return;
      }

      // Setup MQTT handlers for this specific device
      this._setupMqttHandlers();

      this.log('MQTT handlers registered');

    } catch (error) {
      this.error('Failed to initialize MQTT:', error.message);
    }
  }

  /**
   * Reinitialize device after repair
   * Reloads appliance data and reconnects MQTT
   * @public
   * @async
   * @param {Object} applianceInfo - Fresh appliance info from API
   * @returns {Promise<void>}
   * @throws {Error} If reinitialization fails
   * @example
   * // After device repair, reload appliance data
   * const freshApplianceInfo = appliances.find(a => a.macAddress === mac);
   * await this.reinitialize(freshApplianceInfo);
   */
  async reinitialize(applianceInfo) {
    try {
      this.log('🔄 Reinitializing device after repair...');

      const app = this.homey.app;

      // Stop existing connections
      this._unregisterMqttHandlers();

      // Recreate appliance object with fresh data
      this.log('📦 Creating new appliance instance...');
      this._appliance = new HonAppliance(app.getApi(), applianceInfo);

      // Reload commands and attributes
      this.log('📥 Reloading commands...');
      await this._appliance.loadCommands();
      this.log('✅ Commands reloaded:', Object.keys(this._appliance.commands || {}).length);

      // Set translations on appliance
      if (this._appliance.extra) {
        const translations = await app.loadTranslations();
        this._appliance.extra.setTranslations(translations);
        this.log('✅ Translations set on appliance');
      }

      // Attributes are already loaded by loadCommands()
      this.log('✅ Attributes ready');

      // Log available programs again
      const programs = this.getAvailablePrograms();
      this.log('📋 Available programs:', programs.length);

      // Update capabilities with fresh data
      this.log('📥 Updating capabilities...');
      await this._updateCapabilities();
      this.log('✅ Capabilities updated');

      // Reinitialize MQTT
      this.log('📡 Reinitializing MQTT...');
      await this.initializeMqtt();
      this.log('✅ MQTT reinitialized');

      // Mark device as available
      await this.setAvailable();
      this.log('✅ Device reinitialize complete');

    } catch (error) {
      this.error('❌ Failed to reinitialize device:', error.message);
      this.error('Stack:', error.stack);
      throw error;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // HOMEY LIFECYCLE METHODS
  // ═══════════════════════════════════════════════════════════════════════

  /**
 * Initialize device on startup
 * Loads appliance data, registers capability listeners, and sets up MQTT
 * @public
 * @async
 * @returns {Promise<void>}
 * @example
 * // Called automatically when device initializes
 * // Loads appliance from API, sets up MQTT handlers, starts polling
 */
  async onInit() {
    this.log('onInit - Device - Washing Machine Device initializing:', this.getName());

    // Stato interno
    this._appliance = null;
    this._pollInterval = null;
    this._lastMachMode = null; // Track machMode changes for flow triggers

    // Registra capability listeners
    this._registerCapabilityListeners();

    // Registra flow card actions
    this._registerFlowCardActions();

    // Initialize connection
    await this._initializeDevice();

    this.log('Washing Machine Device initialized:', this.getName());
  }

  /**
   * Handle device addition after successful pairing
   * @public
   * @async
   * @returns {Promise<void>}
   * @example
   * // Called automatically after user pairs device
   * // Used to perform post-pairing initialization
   */
  async onAdded() {
    this.log('Washing Machine Device has been added:', this.getName());
  }

  /**
   * Handle device settings changes
   * @public
   * @async
   * @param {Object} options - Settings change options
   * @param {Object} options.oldSettings - Previous settings values
   * @param {Object} options.newSettings - New settings values
   * @param {Array<string>} options.changedKeys - Keys that changed
   * @returns {Promise<void>}
   * @example
   * // Called when user updates device settings in Homey UI
   * // Can validate or respond to setting changes
   */
  async onSettings({ oldSettings, newSettings, changedKeys }) {
    this.log('Device settings changed:', changedKeys);
  }

  /**
   * Handle device rename
   * @public
   * @async
   * @param {string} name - New device name
   * @returns {Promise<void>}
   * @example
   * // Called when user renames device in Homey UI
   * // Log new name or perform related updates
   */
  async onRenamed(name) {
    this.log('Device was renamed to:', name);
  }

  /**
   * Clean up device resources when deleted
   * Stops polling, unregisters MQTT handlers, and clears appliance data
   * @public
   * @async
   * @returns {Promise<void>}
   * @example
   * // Called when user removes device from Homey
   * // Cleans up MQTT listeners and polling intervals
   */
  async onDeleted() {
    this.log('Washing Machine Device deleted:', this.getName());

    // Cleanup
    this._stopPolling();
    this._unregisterMqttHandlers();
    this._appliance = null;
  }

};