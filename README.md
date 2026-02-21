# hOn SmartHome for Homey

[![Homey](https://img.shields.io/badge/Homey-Compatible-blue.svg)](https://homey.app)
[![Version](https://img.shields.io/badge/version-1.0.0-green.svg)](https://github.com/s-dimaio/com.dimapp.hon)
[![License](https://img.shields.io/badge/license-GPL--3.0-blue.svg)](LICENSE)

Unofficial Homey app for Haier/Hoover/Candy hOn smart home appliances. Control your connected washing machines directly from Homey with real-time status updates and powerful automation capabilities.

> **⚠️ Current Support**: This app currently supports **washing machines only**. Support for additional appliance types (dryers, dishwashers, air conditioners, etc.) may be added in future releases.

## Features

### Real-time Monitoring
- **Live Status Updates** via MQTT for instant appliance state changes
- **Connection Status** monitoring with automatic reconnection
- **Program Progress** tracking with remaining time
- **Machine State** detection (idle, running, paused, finished)
- **Temperature & Spin Speed** monitoring

### Device Control
- **Start/Stop Programs** directly from Homey
- **Pause/Resume** wash cycles remotely
- **Program Selection** from available washing programs
- **Temperature Control** with supported temperature settings
- **Spin Speed Adjustment** for optimal fabric care

### Flow Integration
- **When Triggers**: Wash started, wash finished, program phase changed
- **Then Actions**: Start/stop program, pause/resume cycle
- **Conditions**: Machine state, program running status

### Advanced Features
- **Adaptive Polling**: Automatically switches between MQTT (real-time) and API polling (backup) for maximum reliability
- **Multi-language Support**: English and Italian translations included
- **Diagnostic Tools**: Export complete appliance data for troubleshooting
- **Energy Efficiency**: Minimal resource usage with intelligent update management

## Requirements

- Homey Pro or Homey (Early 2019) with firmware ≥12.4.0
- hOn account with registered washing machine
- Active internet connection for cloud communication

## Installation

1. Install the app from the Homey App Store
2. Open the Homey app and go to **Devices** → **Add Device**
3. Select **hOn SmartHome** from the list
4. Enter your hOn account credentials (email and password)
5. Select your washing machine from the discovered devices
6. The device will be added to Homey with real-time monitoring

## Supported Appliances

### Currently Supported
- ✅ **Washing Machines** (WM)
  - All Haier, Candy, and Hoover connected washing machines with hOn app support
  - Full program control and monitoring
  - Real-time MQTT updates
  - 20+ washing programs supported

## Configuration

### Device Settings
Access device settings through the Homey app:
- **Debug Logging**: Enable detailed logs for troubleshooting
- **Export Diagnostics**: Download complete appliance data as JSON

### Flow Examples

**Start washing when electricity is cheap:**
```
WHEN: Energy price drops below 0.10 €/kWh
THEN: Start "Eco 40-60" program
```

**Notify when wash is finished:**
```
WHEN: Wash cycle finished
THEN: Send notification "Laundry is ready!"
```

**Pause washing when leaving home:**
```
WHEN: Last person leaves home
THEN: Pause wash cycle
```

## Technical Details

### Architecture
- **Primary Updates**: MQTT real-time communication via AWS IoT Core
- **Backup Updates**: REST API polling (10-minute intervals, only when MQTT unavailable)
- **Authentication**: Secure token-based authentication with automatic refresh
- **Data Storage**: Minimal local storage for device state and settings

### Libraries Used
- [JavahOn](https://github.com/s-dimaio/JavahOn) - Node.js library for hOn API communication
- Homey SDK v3 - Athom's official development framework

## Troubleshooting

### Device Won't Pair
1. Verify your hOn app credentials are correct
2. Ensure your appliance is online in the official hOn app
3. Check your internet connection
4. Try removing and re-adding the device

### No Real-time Updates
1. MQTT connection may be temporarily down
2. The app will automatically fall back to polling mode
3. Updates will continue every 10 minutes until MQTT reconnects
4. Check device settings → Enable debug logging for details

### Authentication Errors
1. Tokens expire automatically - the app handles refresh
2. If login fails repeatedly, verify credentials in the hOn app
3. Try repairing the device in Homey

## Privacy & Data

This app communicates directly with Haier's hOn cloud services:
- **Authentication**: Your credentials are used only during pairing to obtain access tokens. Only these tokens are stored securely on your Homey, not your password
- **Cloud Communication**: All appliance data passes through Haier's servers
- **No Third Parties**: No data is shared with any third party
- **Local Processing**: Status updates are processed locally on your Homey

## Support & Contributions

### Getting Help
- Report issues on [GitHub Issues](https://github.com/s-dimaio/com.dimapp.hon/issues)

### Contributing
Contributions are welcome! Please:
1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

### Supporting Development
If you find this app useful, consider:
- ⭐ Starring the project on GitHub
- 🐛 Reporting bugs and suggesting features
- 💝 [Supporting](https://www.paypal.com/paypalme/sdimaio77)

## Disclaimer

This is an **unofficial** app and is not affiliated with, endorsed by, or connected to Haier, Candy, Hoover, or any of their subsidiaries. All product names, logos, and brands are property of their respective owners.

The app uses the same API as the official hOn mobile app and does not bypass any security measures. Use at your own risk.

## Credits

- **Developer**: Simone Di Maio
- **JavahOn Library**: Based on [pyhOn](https://github.com/Andre0512/pyhon) by Andre Basche


## License

GNU General Public License v3.0 - See [LICENSE](LICENSE) file for details

---

**Made with ❤️ for the Homey community**
