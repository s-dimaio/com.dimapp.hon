'use strict';

const fs = require('fs');
const path = require('path');
const { HonAppliance } = require('java-hon');

module.exports = {
  /**
   * Generate comprehensive diagnostic data for all appliances on the hOn account
   * Extracts commands, parameters, attributes, statistics, and MQTT configuration
   * Saves to /userdata/hon-diagnostics.json and returns download URL
   * 
   * This data is useful for:
   * - Troubleshooting device communication issues
   * - Implementing support for new device types (dryers, dishwashers, etc.)
   * - Understanding available programs, temperatures, and spin speeds
   * - Analyzing MQTT topics and command parameters
   * 
   * @async
   * @param {Object} params - Homey API parameters
   * @param {Object} params.homey - Homey instance
   * @returns {Promise<Object>} Diagnostic result object
   * @returns {boolean} result.success - Whether generation succeeded
   * @returns {string} result.url - Download URL for the diagnostic file (or null if save failed)
   * @returns {string} result.filePath - Local file path where diagnostics were saved
   * @returns {string} result.fileName - Filename of the diagnostic file
   * @returns {Object} result.data - The complete diagnostic data object
   * @throws {Error} If not authenticated or no appliances found
   * @example
   * // From settings page
   * const result = await Homey.api('GET', '/diagnostics');
   * if (result.success) {
   *   console.log('Diagnostics ready at:', result.url);
   *   console.log('Found', result.data.applianceCount, 'appliances');
   * }
   */
  async getDiagnostics({ homey }) {
    const app = homey.app;

    // Check if authenticated
    if (!app.isAuthenticated()) {
      throw new Error('App not authenticated. Please pair a device first.');
    }

    try {

      // Load appliances
      const appliancesList = await app.loadAppliances();

      if (appliancesList.length === 0) {
        throw new Error('No appliances found on this account.');
      }

      const api = app.getApi();
      const detailedAppliances = [];

      // Explore each appliance
      for (let i = 0; i < appliancesList.length; i++) {
        const appInfo = appliancesList[i];
        const type = appInfo.applianceTypeName || appInfo.applianceType || 'UNKNOWN';
        const name = appInfo.nickName || appInfo.modelName || `Device ${i + 1}`;


        const appliance = new HonAppliance(api, appInfo);

        const applianceData = {
          basicInfo: {
            nickName: appliance.nickName,
            modelName: appliance.modelName,
            brand: appliance.brand,
            type: appliance.applianceType,
            macAddress: appliance.macAddress,
            code: appliance.code,
            modelId: appliance.modelId,
            connection: appliance.connection,
          },
          rawInfo: appInfo,
          commands: null,
          attributes: null,
          statistics: null,
          maintenance: null,
          lastActivity: null,
          mqttTopics: null,
          availablePrograms: null,
          availableTemperatures: null,
          availableSpinSpeeds: null,
        };

        // Load Commands
        try {
          await appliance.loadCommands();
          const commandsDetail = {};

          for (const [cmdName, cmd] of Object.entries(appliance.commands)) {
            commandsDetail[cmdName] = {
              parameters: {},
              availableParameters: Object.keys(cmd.parameters || {}),
            };

            // Extract available programs for startProgram command
            if (cmdName === 'startProgram') {
              // Extract ALL programs from categories (like explore-appliances script)
              const programs = [];
              for (const [name, category] of Object.entries(cmd.categories || {})) {
                const prCode = category.parameters?.prCode?.value;
                const prPosition = category.parameters?.prPosition?.value;
                
                if (prCode !== undefined && prCode !== null) {
                  programs.push({
                    id: name,
                    prCode: parseInt(prCode),
                    prPosition: prPosition !== undefined ? parseInt(prPosition) : null
                  });
                }
              }
              applianceData.availablePrograms = programs.sort((a, b) => a.prCode - b.prCode);
              
              // Extract available temperatures
              if (cmd.parameters?.temp?.values) {
                applianceData.availableTemperatures = Array.from(cmd.parameters.temp.values).map(v => parseInt(v));
              }
              
              // Extract available spin speeds
              if (cmd.parameters?.spinSpeed?.values) {
                applianceData.availableSpinSpeeds = Array.from(cmd.parameters.spinSpeed.values).map(v => parseInt(v));
              }
            }

            for (const [paramName, param] of Object.entries(cmd.parameters || {})) {
              commandsDetail[cmdName].parameters[paramName] = {
                type: param.constructor.name,
                value: param.value,
                min: param.min,
                max: param.max,
                step: param.step,
                values: param.values || param._values,
              };
            }
          }
          applianceData.commands = commandsDetail;
        } catch (error) {
          app.error(`Error loading commands for ${name}:`, error.message);
        }

        // Load Attributes (already loaded by loadAppliances)
        try {
          const params = appliance.attributes?.parameters || {};
          const attributesDetail = {};

          for (const [attrName, param] of Object.entries(params)) {
            attributesDetail[attrName] = {
              type: param.constructor?.name || typeof param,
              value: typeof param === 'object' ? param.value : param,
            };
          }
          applianceData.attributes = attributesDetail;
        } catch (error) {
          app.error(`Error loading attributes for ${name}:`, error.message);
        }

        // Load Statistics (SKIPPED for performance - reduces timeout issues)
        // Uncomment if needed, but may cause Homey.openURL() to fail due to timeout
        try {
          await appliance.loadStatistics();
          applianceData.statistics = appliance.statistics || {};
        } catch (error) {
          app.error(`Error loading statistics for ${name}:`, error.message);
        }

        // Load Last Activity (SKIPPED for performance - reduces timeout issues)
        try {
          const lastActivity = await api.loadLastActivity(appInfo);
          applianceData.lastActivity = lastActivity;
        } catch (error) {
          app.error(`Error loading last activity for ${name}:`, error.message);
         }

        // Load Maintenance (SKIPPED for performance - reduces timeout issues)
        try {
          const maintenance = await api.loadMaintenance(appInfo);
          applianceData.maintenance = maintenance;
        } catch (error) {
          app.error(`Error loading maintenance for ${name}:`, error.message);
        }

        // Extract MQTT topics
        if (appInfo.topics) {
          applianceData.mqttTopics = appInfo.topics;
        }

        detailedAppliances.push(applianceData);
      }

      // Generate complete report
      const diagnosticData = {
        generatedAt: new Date().toISOString(),
        appVersion: homey.manifest.version,
        applianceCount: detailedAppliances.length,
        appliances: detailedAppliances,
      };

      // Save to file for download via URL
      try {
        const fileName = `hon-diagnostics.json`;
        const filePath = path.join('/userdata', fileName);
        
        // Save file
        const diagnosticJson = JSON.stringify(diagnosticData, null, 2);
        fs.writeFileSync(filePath, diagnosticJson, 'utf8');
        
        // Get local IP address
        const localAddress = await homey.cloud.getLocalAddress();
        const ipAddress = localAddress.split(':')[0];
        
        // Build download URL using the file path (Homey will serve it from /userdata)
        const downloadUrl = `http://${ipAddress}/app/com.dimapp.hon/userdata/${fileName}`;
        
        // Return both data and URL
        return {
          success: true,
          url: downloadUrl,
          filePath: filePath,
          fileName: fileName,
          data: diagnosticData
        };
        
      } catch (fileError) {
        app.error('File save failed, returning data only:', fileError.message);
        // Fallback: return data only
        return {
          success: true,
          url: null,
          data: diagnosticData
        };
      }

    } catch (error) {
      app.error('Failed to generate diagnostics:', error.message);
      app.error('Stack:', error.stack);
      throw error;
    }
  },
  /**
   * Clean up old diagnostic JSON files from the userdata directory
   * Deletes files matching the legacy 'hon-diagnostics-*.json' pattern
   * (Note: Current diagnostics use 'hon-diagnostics.json' without timestamp)
   * 
   * @async
   * @param {Object} params - Homey API parameters
   * @param {Object} params.homey - Homey instance
   * @returns {Promise<Object>} Cleanup result object
   * @returns {boolean} result.success - Whether cleanup succeeded
   * @returns {string} result.message - Human-readable result message
   * @returns {number} result.deleted - Number of files deleted
   * @returns {Array<string>} result.deletedFiles - List of deleted filenames
   * @throws {Error} If cleanup process encounters an error
   * @example
   * // Clean up old diagnostic files
   * const result = await Homey.api('DELETE', '/diagnostics');
   * console.log(`Deleted ${result.deleted} files`);
   */
  async cleanupDiagnostics({ homey }) {
    const app = homey.app;

    try {

      const userdataDir = '/userdata';

      // Check if directory exists
      if (!fs.existsSync(userdataDir)) {
        return {
          success: true,
          message: 'No files to clean up',
          deleted: 0
        };
      }

      // Read all files in the directory
      const files = fs.readdirSync(userdataDir);

      // Filter JSON files related to diagnostics
      const diagnosticFiles = files.filter(file => {
        return file.startsWith('hon-diagnostics-') && file.endsWith('.json');
      });

      if (diagnosticFiles.length === 0) {
        return {
          success: true,
          message: 'No diagnostic files found',
          deleted: 0
        };
      }

      // Delete each file
      let deleted = 0;
      const deletedFiles = [];

      diagnosticFiles.forEach(file => {
        const filePath = path.join(userdataDir, file);
        try {
          fs.unlinkSync(filePath);
          deleted++;
          deletedFiles.push(file);
        } catch (error) {
          app.error(`Failed to delete ${file}: ${error.message}`);
        }
      });

      return {
        success: true,
        message: `Deleted ${deleted} diagnostic file(s)`,
        deleted: deleted,
        deletedFiles: deletedFiles
      };

    } catch (error) {
      app.error('❌ Cleanup error:', error.message);
      throw new Error(`Cleanup failed: ${error.message}`);
    }
  },

  /**
   * List all diagnostic files in /userdata/
   */
  async listDiagnosticFiles({ homey }) {
    const app = homey.app;
    
    try {
      const userdataDir = '/userdata';

      // Check if directory exists
      if (!fs.existsSync(userdataDir)) {
        return {
          success: true,
          files: [],
          count: 0
        };
      }

      const files = fs.readdirSync(userdataDir);
      const diagnosticFiles = [];
      const localAddress = await homey.cloud.getLocalAddress();
      const ipAddress = localAddress.split(':')[0];
      
      for (const file of files) {
        if (file.endsWith('.json')) {
          const filepath = path.join(userdataDir, file);
          const stats = fs.statSync(filepath);
          
          diagnosticFiles.push({
            filename: file,
            url: `http://${ipAddress}/app/com.dimapp.hon/userdata/${file}`,
            size: stats.size,
            created: stats.birthtime.toISOString()
          });
        }
      }
      
      // Sort by creation date (newest first)
      diagnosticFiles.sort((a, b) => new Date(b.created) - new Date(a.created));
      
      return {
        success: true,
        files: diagnosticFiles,
        count: diagnosticFiles.length
      };
      
    } catch (error) {
      app.error('[API] Failed to list diagnostic files:', error.message);
      return {
        success: false,
        error: error.message,
        files: [],
        count: 0
      };
    }
  },

  /**
   * Delete a specific diagnostic file from /userdata/
   */
  async deleteDiagnosticFile({ homey, params }) {
    const app = homey.app;
    
    try {
      let { filename } = params;
      
      if (!filename) {
        throw new Error('filename parameter is required');
      }

      // Decode filename if it was URL encoded
      filename = decodeURIComponent(filename);

      // Security: prevent directory traversal
      if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
        throw new Error('Invalid filename');
      }

      const filepath = path.join('/userdata', filename);
      
      // Check if file exists
      if (!fs.existsSync(filepath)) {
        return {
          success: false,
          error: `File not found: ${filename}`
        };
      }
      
      fs.unlinkSync(filepath);
      
      app.log(`[API] Deleted diagnostic file: ${filename}`);
      
      return {
        success: true,
        message: `File ${filename} deleted successfully`,
        deletedFile: filename
      };
      
    } catch (error) {
      app.error('[API] Failed to delete diagnostic file:', error.message);
      return {
        success: false,
        error: error.message
      };
    }
  },
};
