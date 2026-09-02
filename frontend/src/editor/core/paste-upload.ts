import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

/**
 * 붙여넣기·드래그 첨부 업로드 (`FR-ATTACH-004`).
 *
 * **두 경로가 같은 함수를 부른다.** GitHub 마크다운 편집기와 같은 상호작용인데,
 * 붙여넣기와 드래그를 따로 만들면 한쪽에만 크기 제한이 걸리거나 한쪽만
 * 권한을 본다.
 *
 * 올리는 일 자체는 여기서 하지 않는다 — 어디로 보낼지는 셸이 알고,
 * 에디터가 그것을 알면 에디터가 서버 주소를 알게 된다. 콜백 하나를 받아
 * **링크 문자열**만 돌려받는다.
 */
export interface AttachUpload {
  /** 올리고 본문에 넣을 링크를 돌려준다. 실패했으면 `null`. */
  (file: File): Promise<string | null>;
}

/** 파일이 실린 전송인가. 글자 붙여넣기를 가로채면 안 된다. */
function filesOf(data: DataTransfer | null | undefined): File[] {
  if (data === null || data === undefined) return [];
  return [...(data.files ?? [])];
}

/** 커서 자리에 마크다운 링크를 끼운다. 이미지면 `!` 를 앞에 붙인다. */
function insertLink(view: EditorView, file: File, link: string): void {
  const image = file.type.startsWith('image/');
  const text = `${image ? '!' : ''}[${file.name}](${link})`;
  const at = view.state.selection.main;

  view.dispatch({
    changes: { from: at.from, to: at.to, insert: text },
    // 끼운 글자 **뒤에** 커서를 둔다 — 앞에 두면 이어서 치는 글자가
    // 링크 안으로 들어간다.
    selection: { anchor: at.from + text.length },
  });
}

async function handle(view: EditorView, files: readonly File[], upload: AttachUpload): Promise<void> {
  for (const file of files) {
    const link = await upload(file);
    // 거부된 업로드에 링크를 넣으면 열리지 않는 링크가 본문에 남는다.
    if (link !== null) insertLink(view, file, link);
  }
}

export function pasteUploadExtension(upload: AttachUpload): Extension {
  return EditorView.domEventHandlers({
    paste(event, view) {
      const files = filesOf(event.clipboardData);
      if (files.length === 0) return false;

      event.preventDefault();
      void handle(view, files, upload);
      return true;
    },

    drop(event, view) {
      const files = filesOf(event.dataTransfer);
      if (files.length === 0) return false;

      event.preventDefault();
      void handle(view, files, upload);
      return true;
    },
  });
}
