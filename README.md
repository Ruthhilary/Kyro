
# Kyro

### AI-Powered Church Attendance, Seating & Vision Management Platform

Kyro is an AI-powered church management and computer vision platform designed to help churches understand attendance, seating, capacity, and movement within their venues in real time.

The platform combines **computer vision, face re-identification, seat detection, live dashboards, attendance tracking, and church-specific workflows** into one system.

Kyro is designed to reduce manual counting and provide church teams with a clearer view of what is happening across their venue.

---

## Features

### AI Attendance & People Counting

Kyro uses computer vision to detect and track people entering and moving through designated areas.

* Real-time people detection
* Person tracking
* Face re-identification support
* Attendance estimation
* Prevention of duplicate counting within supported tracking flows
* Multi-camera support

### Smart Seating

Kyro can monitor seating areas and identify seat availability.

* Occupied seat detection
* Available seat detection
* Seat-zone monitoring
* Hold-seat zones
* Ignored zones
* Seating capacity visibility
* Support for seating alerts

### Live Vision Dashboard

The dashboard provides a live view of camera and venue activity.

* Camera status
* Live people counts
* Seating information
* Tracking information
* Venue activity
* Camera-specific streams
* Real-time updates through WebSockets

### Church-Specific Workflows

Kyro is designed around real church environments rather than generic people-counting.

Supported workflows include:

* Attendance monitoring
* Seating management
* Altar-call handling
* Service monitoring
* Venue capacity monitoring
* Rota management
* OCR-based information capture
* Department and operational workflows

### Alerts

Kyro can provide alerts when specific conditions occur.

Examples include:

* Seat availability
* Capacity conditions
* Camera issues
* Vision pipeline events
* Configured venue conditions

---

# Architecture

Kyro uses a service-based architecture.

```text
                         ┌─────────────────────┐
                         │      Cameras        │
                         │  USB / Video Input  │
                         └──────────┬──────────┘
                                    │
                                    ▼
                         ┌─────────────────────┐
                         │   Vision Service   │
                         │                     │
                         │ Person Detection   │
                         │ Tracking            │
                         │ Face Re-ID          │
                         │ Seat Detection      │
                         └──────────┬──────────┘
                                    │
                                    ▼
                         ┌─────────────────────┐
                         │       Backend      │
                         │       :8001        │
                         │                     │
                         │ API                 │
                         │ WebSockets          │
                         │ Authentication      │
                         │ Rate Limiting       │
                         └───────┬─────┬───────┘
                                 │     │
                   ┌─────────────┘     └─────────────┐
                   ▼                                 ▼
          ┌─────────────────┐               ┌─────────────────┐
          │   PostgreSQL    │               │      Redis      │
          │    Database     │               │ Cache / Events  │
          └─────────────────┘               └─────────────────┘
                                      
                                      
                         ┌─────────────────────┐
                         │      Dashboard      │
                         │       :3001         │
                         │                     │
                         │ Live Monitoring     │
                         │ Seating             │
                         │ Cameras             │
                         │ Attendance          │
                         └─────────────────────┘
```

---

# Technology Stack

## Frontend

* React
* TypeScript
* JavaScript
* WebSockets
* Modern responsive UI

## Backend

* Python
* FastAPI
* WebSockets
* Redis
* PostgreSQL
* Authentication and authorization
* Rate limiting

## Computer Vision

* Python
* OpenCV
* Person detection
* Person tracking
* Face re-identification
* Camera pipelines
* Seat/zone analysis

## Infrastructure

* Docker
* Docker Compose
* PostgreSQL
* Redis
* Nginx

---

# Project Structure

The project is separated into several major services.

```text
Kyro/
│
├── backend/
│   ├── API
│   ├── authentication
│   ├── WebSockets
│   ├── database
│   └── business logic
│
├── dashboard/
│   ├── components
│   ├── pages
│   ├── hooks
│   └── live monitoring UI
│
├── vision/
│   ├── camera pipelines
│   ├── person detection
│   ├── tracking
│   ├── face re-identification
│   └── seating analysis
│
├── docker-compose.yml
├── .env
└── README.md
```

> The exact directory structure may change as Kyro develops.

---

# Running Kyro Locally

## Requirements

Before running Kyro, install:

* Docker
* Docker Compose
* Git
* A Linux environment is recommended for camera-based development
* A compatible camera for live vision functionality

For GPU-based computer vision workloads, compatible GPU drivers and runtime configuration may also be required.

---

## Clone the Repository

```bash
git clone <repository-url>
cd Kyro
```

---

## Configure Environment Variables

Create the environment file:

```bash
cp .env.example .env
```

Then configure the required values.

Example:

```env
DATABASE_URL=postgresql://postgres:postgres@postgres:5432/kyro
REDIS_URL=redis://redis:6379
SECRET_KEY=change-this-secret
```

**Do not commit production secrets to GitHub.**

---

# Start Kyro

Run:

```bash
docker compose up -d
```

Check the running services:

```bash
docker compose ps
```

A typical development environment contains:

```text
postgres
redis
backend
dashboard
vision
```

---

# Development Ports

| Service     |   Port |
| ----------- | -----: |
| Backend API | `8001` |
| Dashboard   | `3001` |
| PostgreSQL  | `5432` |
| Redis       | `6379` |
| Nginx       |   `80` |

The backend is exposed locally through:

```text
http://localhost:8001
```

The dashboard is available at:

```text
http://localhost:3001
```

---

# Camera Setup

Kyro supports camera input through compatible video devices.

On Linux, cameras may appear as:

```text
/dev/video0
/dev/video1
```

Check available video devices with:

```bash
ls /dev/video*
```

You can inspect connected video devices with:

```bash
v4l2-ctl --list-devices
```

If a camera is available on the host but not inside the Docker container, the container must be given access to the relevant video device.

For example:

```yaml
devices:
  - /dev/video0:/dev/video0
```

The exact configuration depends on the camera and deployment environment.

---

# WebSocket Streaming

Kyro uses WebSockets for real-time communication between the vision services and dashboard.

Camera streams are associated with camera IDs such as:

```text
cam-01
cam-stadium
```

The WebSocket layer is authenticated and requires a valid token.

This prevents unauthenticated clients from connecting directly to camera pipelines.

---

# Security

Security is an important part of Kyro's architecture.

Current security considerations include:

* Authenticated WebSocket connections
* Environment-based secrets
* Rate limiting
* Redis-backed infrastructure
* Protected API endpoints
* Separation between frontend and backend services
* Docker service isolation

### Important

Never commit:

```text
.env
API keys
database passwords
JWT secrets
private credentials
production configuration
```

to the repository.

---

# Database

Kyro uses PostgreSQL for persistent application data.

Redis is used for infrastructure functionality such as:

* Caching
* Rate limiting
* Temporary state
* Event-related workflows

Database migrations should be applied according to the backend's migration configuration.

---

# Vision Pipeline

Each camera can run a dedicated vision pipeline.

A simplified flow is:

```text
Camera
   ↓
Frame Capture
   ↓
Person Detection
   ↓
Tracking
   ↓
Face Re-Identification
   ↓
Zone / Seat Analysis
   ↓
Event Processing
   ↓
Backend
   ↓
Dashboard
```

The vision system can associate detections with temporary tracking identifiers.

Example:

```text
track:123
track:124
track:125
```

These identifiers allow the system to follow individuals across frames.

---

# Multi-Camera Considerations

Kyro supports multiple cameras, but multi-camera deployments require careful configuration.

When cameras overlap, the same person may be visible in more than one camera.

For example:

```text
Camera A ───────┐
                │
                ▼
             Same Person
                ▲
                │
Camera B ───────┘
```

Without venue-level cross-camera identity reconciliation, the same individual could potentially be counted more than once.

Therefore, multi-camera deployments should define:

* Camera coverage
* Camera overlap
* Tracking boundaries
* Venue zones
* Identity reconciliation rules

---

# Zones

Kyro uses zones to determine how different parts of a venue should be interpreted.

Examples include:

```text
hold_seats
ignore
entrance
exit
main_area
altar
```

A zone can control whether detections contribute to specific calculations.

For example, an `ignore` zone can prevent an area from affecting attendance calculations.

---

# Altar Call Handling

Church services can contain events where normal attendance logic does not apply.

For example, during an altar call, people may move from their normal seats into another area.

Kyro includes logic designed to prevent these movements from incorrectly distorting normal seating or attendance measurements.

---

# Rota Management

Kyro also includes operational functionality for managing church rotas.

Rota functionality can include:

* Date selection
* Time selection
* Team assignment
* Scheduling
* Service planning

---

# OCR

Kyro can use OCR for supported information-capture workflows.

The system is designed to favour practical and lightweight OCR approaches where possible rather than requiring unnecessary paid OCR services.

---

# API

The backend exposes API endpoints for communication with the dashboard and other services.

API functionality includes areas such as:

```text
Authentication
Cameras
Attendance
Seats
Zones
Rota
Events
Vision
System status
```

The exact API routes should be treated as implementation details and may change during development.

---

# Health Checks

Check running containers:

```bash
docker compose ps
```

View backend logs:

```bash
docker compose logs backend
```

View dashboard logs:

```bash
docker compose logs dashboard
```

View vision logs:

```bash
docker compose logs vision
```

Follow logs in real time:

```bash
docker compose logs -f
```

Restart the stack:

```bash
docker compose restart
```

Stop the stack:

```bash
docker compose down
```

---

# Troubleshooting

## Backend is not responding

Check:

```bash
docker compose ps
```

Then:

```bash
docker compose logs backend
```

---

## Dashboard is not loading

Check whether port `3001` is already being used:

```bash
sudo lsof -i :3001
```

Then inspect:

```bash
docker compose logs dashboard
```

---

## Camera is not detected

Check the host:

```bash
ls /dev/video*
```

Then:

```bash
v4l2-ctl --list-devices
```

If the device exists on the host but not inside the container, check the Docker device configuration.

---

## WebSocket keeps reconnecting

Check:

```bash
docker compose logs backend
```

and:

```bash
docker compose logs dashboard
```

Verify:

* Authentication token
* WebSocket URL
* Camera ID
* Backend availability
* Network configuration

---

# Development Principles

Kyro is built around several principles:

### Privacy

Camera and attendance data should be handled responsibly and only for legitimate operational purposes.

### Security

Authentication, secrets management and access controls should be considered throughout the system.

### Reliability

The system should continue operating predictably when individual cameras or services experience problems.

### Modularity

Vision, backend and dashboard functionality should remain independently maintainable.

### Real-World Usability

Features should solve genuine problems faced by church teams rather than adding unnecessary complexity.

---

# Roadmap

Potential future development includes:

* Improved multi-camera identity reconciliation
* More advanced seating analytics
* Improved camera management
* Attendance analytics
* Historical service reports
* More configurable alerts
* Improved dashboard visualisation
* Advanced venue configuration
* Improved AI-assisted insights
* Mobile support
* Production deployment tooling

---

# Privacy & Responsible AI

Kyro involves computer vision and potentially sensitive attendance information.

Any real-world deployment should consider:

* Appropriate consent and transparency
* Data minimisation
* Access controls
* Retention periods
* Secure storage
* Appropriate legal and organisational requirements
* Responsible use of biometric or identity-related functionality

The system should not be deployed in a real venue without appropriate review of the applicable privacy, safeguarding and data-protection requirements.

---

# Status

**Kyro is currently under active development.**

Features, APIs, database structures and deployment configurations may change as the platform develops.

---

# Project Vision

Kyro aims to provide churches with a modern technical infrastructure for understanding their venues without replacing the people who operate them.

The long-term vision is to combine:

**AI + Computer Vision + Church Operations + Real-Time Data**

into one platform that helps church teams manage their services and venues more effectively.




Built with Python, React, Docker, computer vision and AI.
