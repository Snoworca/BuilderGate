#!/bin/zsh
# BuilderGate OSC 133 Shell Integration for Zsh
# 이 스크립트는 ZDOTDIR/.zshrc에서 자동 로드된다.

# 중복 로드 방지
if [[ -n "$__BUILDERGATE_OSC133" ]]; then
  return 0
fi
export __BUILDERGATE_OSC133=1

# === precmd: 프롬프트 출력 전 ===
__bg_precmd() {
  local exit_code=$?
  # D 마커 (이전 명령 종료)
  if [[ -n "$__bg_command_running" ]]; then
    printf '\e]133;D;%s\a' "$exit_code"
    unset __bg_command_running
  fi
  # A 마커 (프롬프트 시작)
  printf '\e]133;A\a'
}

# === preexec: 명령 실행 직전 ===
__bg_preexec() {
  __bg_command_running=1
  # C 마커 (명령 실행 시작)
  printf '\e]133;C\a'
}

# Hook 등록 (기존 hook 보존)
autoload -Uz add-zsh-hook
add-zsh-hook precmd __bg_precmd
add-zsh-hook preexec __bg_preexec

# PS1에 B 마커 추가
PS1="${PS1}"$'\e]133;B\a'
