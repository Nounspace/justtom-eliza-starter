# Project Technology Stack

## Overview
This document outlines the core technologies, languages, frameworks, and tools utilized in the Eliza AI Agent Operating System.

## Programming Languages
*   **TypeScript:** Primary language for most modules, leveraging its type-safety for robust development.
*   **JavaScript:** Used in various contexts, especially for build scripts and client-side logic.
*   **Python:** Utilized for specific functionalities, likely related to AI/ML components or scripting, as indicated by project prerequisites.

## Core Frameworks & Runtimes
*   **Node.js:** The primary runtime environment for the Eliza agent and backend services (Node.js 23.3.0 specified).
*   **React:** The frontend library used for building user interfaces, particularly for the client application.
*   **Vite:** A fast build tool that serves as the development server and bundler for the frontend.

## Monorepo & Build Management
*   **pnpm:** The package manager of choice, enforcing a strict dependency hoisting model and efficient disk space usage, crucial for a monorepo.
*   **Turbo:** A high-performance build system for monorepos, enabling fast and incremental builds across packages.

## Code Quality & Development Tools
*   **Biome:** Used for code formatting and linting, ensuring consistent code style and identifying potential issues.
*   **TypeScript:** Provides static type checking across the codebase.
*   **Jest:** A JavaScript testing framework used for unit and integration tests.
*   **Vitest:** A modern, fast test runner powered by Vite, also used for testing.

## Data Storage & Access
*   **SQLite:** Implied as a local database solution, likely for the agent's internal data storage.
*   **Various Adapters:** The presence of `packages/adapter-*` directories indicates support for diverse database systems including MongoDB, PostgreSQL, and other SQL-based solutions, suggesting flexibility in data persistence.

## Key Libraries & Integrations
*   **Web3.js & Ethereum Ecosystem Libraries:** Extensive integration with Web3 technologies, including SDKs from `@0glabs/0g-ts-sdk`, `@coinbase/coinbase-sdk`, `@injectivelabs/sdk-ts`, for blockchain interactions.
*   **AI/ML Providers:** Integrations with `ollama-ai-provider` and `@deepgram/sdk` highlight the project's focus on leveraging various AI and speech-to-text capabilities.
*   **Sharp:** An image processing library, likely used for handling visual assets or transformations.

## Architecture Pattern
*   **Monorepo:** The project is structured as a monorepo, organizing multiple distinct packages within a single repository, fostering code sharing and simplified dependency management.
