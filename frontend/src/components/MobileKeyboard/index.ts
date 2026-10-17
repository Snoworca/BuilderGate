// @req FR-MKB-006
// @req FR-MKB-011
export { LatchKey } from './LatchKey.tsx';
export type { LatchKeyProps } from './LatchKey.tsx';
export { MobileKeyBar } from './MobileKeyBar.tsx';
export type { MobileKeyBarProps } from './MobileKeyBar.tsx';
export { MobileSpecialKeyboard } from './MobileSpecialKeyboard.tsx';
export type { MobileSpecialKeyboardProps } from './MobileSpecialKeyboard.tsx';
export {
  DEFAULT_SPECIAL_PANEL_HEIGHT,
  MOBILE_BAR_KEYS,
  RIGHT_BLOCK_STORAGE_KEY,
  SPECIAL_ARROW_BLOCK,
  SPECIAL_LEFT_BLOCK,
  SPECIAL_MIDDLE_BLOCK,
  SPECIAL_NUMPAD_BLOCK,
  SPECIAL_TOP_ROW,
  TAP_SLOP_PX,
  applySpecialKeyboardToggle,
  isDragBeyond,
  readRightBlock,
  shouldShowMobileKeyBar,
  specialPanelHeight,
  useResetLatchWhenNotMobile,
  useSpecialKeyboardPanel,
  useTapPress,
  writeRightBlock,
} from './mobileKeyboardModel.ts';
export type {
  MobileBarEntry,
  MobileKeyBarVisibility,
  RightBlock,
  SpecialKeyEntry,
  SpecialKeyboardFocusTarget,
  SpecialKeyboardPanel,
  SpecialKeyboardPanelOptions,
  SpecialKeyboardPanelTarget,
} from './mobileKeyboardModel.ts';
