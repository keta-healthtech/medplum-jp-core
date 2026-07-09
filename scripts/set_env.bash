#!/usr/bin/env bash
set -euo pipefail

echo -e "\n== set_env.bash =="

# Must be run from parent (not /scripts)
if [[ "$(basename "$(pwd)")" == "scripts" ]]; then
  echo -e "\nRun this script from the parent directory\n"
  exit 1
fi

missing=false

# Check .env.dev
if [[ ! -f ".env.dev" ]]; then
  if [[ -f ".env.dev.example" ]]; then
    cp .env.dev.example .env.dev
    echo ".env.dev not found — copying from .env.dev.example"
  else
    echo "ERROR: .env.dev not found and .env.dev.example missing."
  fi
  missing=true
fi

# Check .env.prod
if [[ ! -f ".env.prod" ]]; then
  if [[ -f ".env.prod.example" ]]; then
    cp .env.prod.example .env.prod
    echo ".env.prod not found — copying from .env.prod.example"
  else
    echo "ERROR: .env.prod not found and .env.prod.example missing."
  fi
  missing=true
fi

# If any were missing, ask user to set values first and exit
if [[ "${missing}" == "true" ]]; then
  echo "Please fix missing files above and re-run the script."
  exit 0
fi

# Files exist — require a parameter: dev|prod
if [[ $# -lt 1 || ( "$1" != "dev" && "$1" != "prod" ) ]]; then
  echo "Usage: $0 <dev|prod>"
  exit 1
fi

env_choice="$1"
cmds=(
  "cp .env.${env_choice} .env"
)

for cmd in "${cmds[@]}"; do
  echo "${cmd}"
  eval "${cmd}"
done

exit 0
