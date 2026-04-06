# Driver Ledger - Fuel Consumption Tracker

## Project Overview
- **Project Name**: Driver Ledger PH
- **Type**: Progressive Web App (PWA) - Native-like experience on iOS/Android
- **Core Functionality**: Track fuel consumption for multiple drivers with custom consumption rates, manage users, and generate year-end reports
- **Target Users**: Fleet managers, vehicle owners in the Philippines

## UI/UX Specification

### Layout Structure
- **Navigation**: Bottom tab bar (mobile-native feel) with 4 main sections
- **Header**: Fixed top bar with app title and user menu
- **Content**: Scrollable main area with cards/lists
- **Footer**: None (bottom nav handles all)

### Responsive Breakpoints
- Mobile: 320px - 480px (primary target)
- Tablet: 481px - 768px
- Desktop: 769px+

### Visual Design
- **Color Palette**:
  - Primary: #1E3A5F (Deep Navy Blue)
  - Secondary: #F59E0B (Amber/Gold - Filipino flag accent)
  - Accent: #10B981 (Emerald Green)
  - Background: #F8FAFC (Light Gray)
  - Surface: #FFFFFF (White)
  - Error: #EF4444 (Red)
  - Text Primary: #1F2937
  - Text Secondary: #6B7280

- **Typography**:
  - Font Family: System UI (native feel)
  - Headings: 700 weight, 1.5rem-2rem
  - Body: 400 weight, 1rem
  - Labels: 500 weight, 0.875rem

- **Spacing**: 8px base unit (0.5rem)
- **Border Radius**: 12px for cards, 8px for inputs, 24px for buttons

- **Visual Effects**:
  - Card shadows: 0 2px 8px rgba(0,0,0,0.08)
  - Press states: scale(0.98) transform
  - Smooth transitions: 200ms ease

### Components
1. **Bottom Navigation** - 4 tabs with icons: Dashboard, Drivers, Records, Settings
2. **Driver Card** - Shows driver name, vehicle, consumption rate, total fuel
3. **Fuel Entry Form** - Date, liters, price per liter, odometer
4. **User Management Panel** - Create/edit users with roles
5. **Percentage Editor** - Custom consumption rate per driver (km/L)
6. **Year End Report** - Exportable summary for tax/compiry
7. **Add Button** - Floating action button for quick entry

## Functionality Specification

### Core Features
1. **Driver Management**
   - Add/edit/delete drivers
   - Assign vehicle (plate number, model)
   - Set custom fuel consumption rate (km/L) per driver
   - Mark as petrol or diesel vehicle

2. **Fuel Entry Recording**
   - Date of entry (defaults to today)
   - Liters consumed
   - Price per liter (PHP)
   - Total cost (auto-calculated)
   - Odometer reading
   - Select driver

3. **User Management**
   - Create users with username/password
   - User roles: Admin, Manager, Viewer
   - Login/logout functionality

4. **Dashboard**
   - Total fuel consumed this month
   - Total cost in PHP
   - Average consumption rate
   - Recent entries list

5. **Year-End Records**
   - Summary by driver
   - Total liters, total cost
   - Export to CSV
   - Filter by year

6. **PWA Features**
   - Installable on home screen
   - Works offline
   - Native app feel on iOS/Android

### Data Handling
- LocalStorage for data persistence (no backend needed)
- JSON format for all records
- Auto-save on changes

### Edge Cases
- Empty state handling for no drivers/records
- Validation for required fields
- Numeric input validation
- Date range validation

## Acceptance Criteria
1. App installs on iOS Safari and Android Chrome
2. Bottom navigation works smoothly with tap animations
3. Drivers can be created with custom km/L percentage
4. Fuel entries save correctly with PHP currency formatting
5. Year-end report generates accurate totals
6. User can be created and login works
7. All data persists after app close
8. Responsive on mobile devices
