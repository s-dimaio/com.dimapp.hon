'use strict';

const Homey = require('homey');

/**
 * Driver for hOn washing machines
 * Manages pairing and device detection
 */
module.exports = class WashingMachineDriver extends Homey.Driver {

  /**
   * onInit is called when the driver is initialized.
   */
  async onInit() {
    this.log('onInit - Driver - WashingMachineDriver initialized');
  }

  /**
   * onPair is called when a user starts pairing
   * @param {PairSession} session - Pairing session
   */
  async onPair(session) {

    const app = this.homey.app;
    let skipLogin = false;

    // Check if app is already authenticated
    if (app.isAuthenticated()) {
      skipLogin = true;
    } else {
      // Try to restore session from saved tokens
      const restored = await app._tryRestoreSession();
      if (restored) {
        skipLogin = true;
      }
    }


    // Handler to automatically skip login view when already authenticated
    session.setHandler('showView', async (viewId) => {
      this.log(`View changed to: ${viewId}`);
      
      // When the login view is about to show, but we're already authenticated
      if (viewId === 'login_credentials' && skipLogin) {
        this.log('Skipping login view, user already authenticated');
        // Programmatically show the next view (list_devices)
        await session.showView('list_devices');
        return; // Important: don't return anything, just change the view
      }
    });

    // Login handler (only used if needed)
    session.setHandler('login', async (data) => {
      
      const email = data.username;
      const password = data.password;

      try {
        // Use app to authenticate
        await app.authenticate(email, password);
        return true;
      } catch (error) {
        this.error('Login failed:', error.message);
        throw new Error(this.homey.__('pair.login_failed') || `Login failed: ${error.message}`);
      }
    });

    // Handler to list devices
    session.setHandler('list_devices', async () => {

      try {
        if (!app.isAuthenticated()) {
          throw new Error('Not authenticated');
        }

        // Load appliances
        this.log('🔍 list_devices - Loading appliances from API...');
        const appliancesList = await app.loadAppliances();
        this.log(`🔍 list_devices - Total appliances from API: ${appliancesList.length}`);

        // Log all appliances before filtering to help diagnose type mismatches
        appliancesList.forEach((appliance, i) => {
          const type = appliance.applianceTypeName || appliance.applianceType || '?';
          const name = appliance.nickName || appliance.modelName || '?';
          const mac = appliance.macAddress || appliance.serialNumber || '?';
          this.log(`🔍   [${i}] type="${type}" | name="${name}" | mac="${mac}"`);
        });

        // Filter only washing machines (WM = Washing Machine)
        const washingMachines = appliancesList.filter(appliance => {
          const type = appliance.applianceTypeName || appliance.applianceType || '';
          return type.toUpperCase() === 'WM';
        });

        this.log(`🔍 list_devices - Washing machines after filter (type=WM): ${washingMachines.length}`);
        if (appliancesList.length > 0 && washingMachines.length === 0) {
          this.error('⚠️  list_devices - No WM devices found. Check the types above — they may have changed or the account may list no devices.');
        }

        // Map to Homey format
        const devices = washingMachines.map(appliance => {
          const macAddress = appliance.macAddress || appliance.serialNumber || '';
          const nickName = appliance.nickName || appliance.modelName || 'Washing Machine';
          const modelName = appliance.modelName || '';
          const serialNumber = appliance.serialNumber || '';
          
          return {
            name: nickName,
            data: {
              id: macAddress, // Unique device identifier
            },
            store: {
              macAddress: macAddress,
              applianceType: 'WM',
              applianceModelId: appliance.applianceModelId || '',
              code: appliance.code || '',
            },
            settings: {
              macAddress: macAddress,
              modelName: modelName,
              serialNumber: serialNumber,
            },
          };
        });

        this.log(`🔍 list_devices - Returning ${devices.length} device(s) to Homey pairing UI`);
        return devices;
      } catch (error) {
        this.error('Failed to list devices:', error.message);
        throw new Error(this.homey.__('pair.list_failed') || `Failed to list devices: ${error.message}`);
      }
    });


    // Disconnect handler
    session.setHandler('disconnect', async () => {
    });
  }

  /**
   * onRepair is called when a user wants to repair a device
   * @param {PairSession} session - Repair session
   * @param {Homey.Device} device - Device being repaired
   */
  async onRepair(session, device) {

    session.setHandler('login', async (data) => {

      const email = data.username;
      const password = data.password;

      try {
        // First logout to clean up state
        const app = this.homey.app;
        await app.logout();

        // Then re-authenticate
        await app.authenticate(email, password);

        // Reload appliances to get fresh data
        const appliances = await app.loadAppliances();
        
        // Find this device's appliance
        const macAddress = device.getStoreValue('macAddress');
        const applianceInfo = appliances.find(a => 
          (a.macAddress || a.serialNumber) === macAddress
        );
        
        if (!applianceInfo) {
          throw new Error('Device not found in hOn account after repair');
        }
        
        this.log('Appliance found, reinitializing device...');
        
        // Reinitialize the device with fresh appliance data
        await device.reinitialize(applianceInfo);
        return true;
      } catch (error) {
        this.error('Repair login failed:', error.message);
        throw new Error(this.homey.__('repair.login_failed') || `Repair failed: ${error.message}`);
      }
    });

    session.setHandler('disconnect', async () => {
    });
  }

};
