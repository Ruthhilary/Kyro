Yes — I’d make it much more polished and investor/engineering-facing, while not claiming features Kyro doesn’t actually have.

Here’s a completely new README you can use:

Kyro

AI-Powered Attendance & Smart Seating Intelligence

Kyro is an AI-powered attendance and classroom intelligence platform designed to make physical learning environments more measurable, efficient, and responsive.

Instead of relying entirely on manual registers, Kyro uses computer vision, intelligent tracking, and real-time seat-state analysis to understand what is happening across a classroom.

Attendance. Seating. Presence. Availability. Intelligence.

⸻

What is Kyro?

Traditional attendance systems tell you who was marked present.

Kyro is designed to go further.

It combines computer vision and intelligent classroom analytics to help institutions understand:

* Who is present
* Where people are seated
* Which seats are occupied or available
* How occupancy changes over time
* When a person’s presence changes
* Attendance and seating patterns
* Real-time classroom activity

The goal is to turn a physical classroom into a data-aware environment without requiring teachers to manually monitor every change.

⸻

Core Capabilities

AI Attendance

Kyro uses computer vision to detect and track people within a defined classroom environment.

The system can support:

* Automated presence detection
* Person tracking
* Attendance state changes
* Persistent tracking across frames
* Attendance analytics
* Evidence associated with important state changes

⸻

Smart Seating

Kyro maps detected people onto predefined classroom seating zones.

This allows the system to understand the difference between:

Person detected → Seat occupied → Seat becomes available

Rather than simply displaying a changing colour on a dashboard, Kyro is designed around actual seat-state transitions.

This creates the foundation for intelligent seat availability alerts and classroom analytics.

⸻

Person Tracking

Kyro uses multi-object tracking to maintain consistent identities while people move through the camera view.

The vision pipeline is designed around:

* Person detection
* Tracking IDs
* Seat-zone assignment
* Track lifecycle management
* Re-identification support
* Configurable retention

This helps reduce the instability that can occur when detections disappear temporarily between frames.

⸻

Face Re-Identification

Kyro can optionally use local face re-identification to improve identity continuity.

The system includes configurable controls for:

* Face re-identification
* Retention periods
* Identity matching
* Local processing

Face re-identification can also be disabled when it is not required.

⸻

Real-Time Seat Availability

Kyro monitors changes in seat occupancy rather than treating the seating grid as a static display.

When a seat transitions between states, the system can capture information about the transition and provide the foundation for real-time availability notifications.

This enables future use cases such as:

“Seat 14 has become available.”

instead of requiring users to continuously watch the dashboard.

⸻

Architecture

Kyro is built as a modular system separating the application, AI processing, computer vision and data services.

                    ┌──────────────────────┐
                    │       Camera         │
                    └──────────┬───────────┘
                               │
                               ▼
                    ┌──────────────────────┐
                    │   Vision Pipeline    │
                    │                      │
                    │ Detection            │
                    │ Tracking             │
                    │ Seat Zones           │
                    │ Re-ID                │
                    └──────────┬───────────┘
                               │
                               ▼
                    ┌──────────────────────┐
                    │     Backend API       │
                    │                      │
                    │ Attendance           │
                    │ Seating               │
                    │ Events               │
                    │ Analytics             │
                    └───────┬───────┬──────┘
                            │       │
                   ┌────────┘       └────────┐
                   ▼                         ▼
            ┌──────────────┐          ┌──────────────┐
            │ PostgreSQL   │          │    Redis     │
            └──────────────┘          └──────────────┘
                            │
                            ▼
                    ┌──────────────────────┐
                    │      Dashboard       │
                    │                      │
                    │ Attendance           │
                    │ Seating              │
                    │ Analytics            │
                    │ Alerts               │
                    └──────────────────────┘

⸻

Technology

AI & Computer Vision

* Python
* Computer Vision
* Object Detection
* Multi-Object Tracking
* ByteTrack
* Face Re-Identification
* Seat-Zone Mapping

Backend

* Python
* REST API architecture
* PostgreSQL
* Redis

Frontend

* React
* Next.js
* Internationalisation
* Real-time dashboard interfaces

Infrastructure

* Docker
* Docker Compose
* Linux
* Containerised services

⸻

Internationalisation

Kyro is being designed for use across different environments and languages.

The interface supports internationalisation with languages including:

* English
* French
* Krio
* Twi

The architecture allows additional languages to be added without rebuilding the application.

⸻

Privacy by Design

Computer vision systems operating in educational environments require careful consideration of privacy.

Kyro is designed with configurable AI processing and identity features rather than assuming that every capability should always be enabled.

For example, face re-identification can be disabled through configuration.

The broader objective is to support local, controlled processing wherever practical and to make sensitive functionality explicit and configurable.

⸻

Running Kyro Locally

Requirements

* Linux
* Docker
* Docker Compose
* Python
* Node.js
* A compatible camera

Clone the repository:

git clone https://github.com/Ruthhilary/Kyro.git
cd Kyro

Start the application:

docker compose up -d

Check the running services:

docker compose ps

The development environment exposes the application through the configured frontend and backend ports.

Typical local endpoints:

Dashboard:
http://localhost:3001
Backend:
http://localhost:8001

Ports may vary depending on your Docker Compose configuration.

⸻

Camera Setup

Kyro can work with locally connected cameras exposed through Linux video devices.

For example:

ls /dev/video*

A camera may appear as:

/dev/video0
/dev/video1

Camera access is passed into the vision container so that the AI pipeline can process the live video stream.

⸻

Configuration

Kyro uses environment-based configuration for deployment-specific settings.

Examples include:

FACE_REID_ENABLED
FACE_REID_RETENTION_SECONDS

This allows features to be enabled, disabled or tuned without changing the core application code.

⸻

Project Structure

Kyro/
│
├── ai/
│   ├── vision/
│   ├── tracking/
│   ├── reid/
│   └── configuration/
│
├── backend/
│   ├── api/
│   ├── models/
│   ├── services/
│   └── migrations/
│
├── dashboard/
│   ├── components/
│   ├── pages/
│   └── public/
│
├── docker-compose.yml
└── README.md

The exact structure may evolve as the platform develops.

⸻

Design Principles

Kyro is built around several principles:

1. Real-world events, not just UI states

A seat changing colour isn’t enough.

Kyro models meaningful transitions such as:

Occupied
    ↓
Person leaves
    ↓
Seat becomes available
    ↓
Availability event
    ↓
Notification / analytics

2. Modular AI

Vision, tracking, identity and application logic are separated so individual components can evolve independently.

3. Configurable privacy

Sensitive capabilities should be configurable rather than forced upon every deployment.

4. Real-time intelligence

Kyro is designed to react to changes as they happen rather than relying exclusively on post-processed attendance reports.

⸻

Roadmap

Kyro is actively being developed.

Planned and ongoing areas include:

* [x]	AI-powered person detection
* [x]	Multi-object tracking
* [x]	Classroom seat zones
* [x]	Attendance dashboard
* [x]	Docker-based development environment
* [x]	Configurable face re-identification
* [x]	Multi-language interface foundation
* [ ]	Real-time seat availability notifications
* [ ]	Improved evidence capture
* [ ]	Advanced attendance analytics
* [ ]	Historical classroom utilisation
* [ ]	Improved identity continuity
* [ ]	Notification integrations
* [ ]	Multi-camera classroom support
* [ ]	Production deployment tooling

⸻

Why Kyro?

Attendance technology has largely focused on recording a register.

Kyro explores a different approach:

What if the physical classroom itself could become an intelligent source of information?

By combining computer vision, tracking, seating intelligence and real-time events, Kyro aims to give educators and institutions a clearer understanding of how learning spaces are actually being used.

⸻

Status

Kyro is currently under active development.

The project is being developed as a modular AI/computer-vision platform, with functionality and architecture continuing to evolve.

Some components are experimental and should not yet be considered production-ready.

⸻


Built with Python, computer vision, cloud-native development and a focus on practical AI systems.

⸻

Licence

This project is currently under active development. Licensing information will be added as the project moves toward a public release.
