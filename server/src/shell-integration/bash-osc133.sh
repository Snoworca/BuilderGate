#!/bin/bash
# BuilderGate OSC 133 Shell Integration for Bash (4.4+)
# 이 스크립트는 BASH_ENV를 통해 자동 로드된다.

# 중복 로드 방지
if [[ -n "$__BUILDERGATE_OSC133" ]]; then
  return 0
fi
export __BUILDERGATE_OSC133=1

# === OSC 133 마커 함수 ===

__bg_osc133_prompt_start() {
  printf '\e]133;A\a'
}

__bg_osc133_prompt_end() {
  printf '\e]133;B\a'
}

__bg_osc133_command_start() {
  printf '\e]133;C\a'
}

__bg_osc133_command_end() {
  printf '\e]133;D;%s\a' "$?"
}

# === PROMPT_COMMAND: 프롬프트 출력 전 (명령 종료 + 프롬프트 시작) ===

# 기존 PROMPT_COMMAND 보존
__bg_original_prompt_command="$PROMPT_COMMAND"

__bg_prompt_command() {
  local exit_code=$?
  # D 마커 (이전 명령 종료). 첫 프롬프트에서는 건너뜀.
  if [[ -n "$__bg_command_running" ]]; then
    printf '\e]133;D;%s\a' "$exit_code"
    unset __bg_command_running
  fi
  # A 마커 (프롬프트 시작)
  printf '\e]133;A\a'
  # 기존 PROMPT_COMMAND 실행
  if [[ -n "$__bg_original_prompt_command" ]]; then
    eval "$__bg_original_prompt_command"
  fi
}

PROMPT_COMMAND='__bg_prompt_command'

# === PS0: 명령 실행 직전 (bash 4.4+) ===
# PS0는 Enter 후 명령 실행 직전에 출력됨

__bg_ps0() {
  printf '\e]133;C\a'
}

# PS0에 직접 이스케이프 할당 (함수 호출은 PS0에서 불안정)
PS0=$'\e]133;C\a'

# PS1에 B 마커 추가 (프롬프트 끝)
# 기존 PS1 뒤에 B 마커를 붙임
PS1="${PS1}"$'\e]133;B\a'

# 명령 실행 추적 변수
__bg_command_running=""

# DEBUG trap: 명령 실행 시마다 호출
__bg_preexec() {
  __bg_command_running=1
}
trap '__bg_preexec' DEBUG
