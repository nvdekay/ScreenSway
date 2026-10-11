# Kiểm tra Windows — 11/10/2026

Trạng thái: build NSIS, 10 bước E2E trên app đã cài và kiểm tra uninstall đã PASS.
Chưa chứng nhận toàn bộ ma trận máy/thiết bị và tình huống lỗi để phát hành rộng rãi.

## Phạm vi và bằng chứng

Máy Windows 11 Pro build 26200, Intel Core i5-1235U, Intel Iris Xe driver
31.0.101.4032, khoảng 19.7 GiB RAM, màn hình 1920×1080, một microphone.
Base revision: `7ef05c39735f5f06f9248ececd720baa180e9b16`.
Workspace có thay đổi chưa commit; kết quả không đại diện cho một tag release.
Bộ [61 testcase](windows-release-test-plan.md) là tiêu chí chấp nhận, không phải
danh sách đã chạy hết. Trường hợp chưa chạy giữ trạng thái NOT RUN.

| Kiểm tra thực tế | Kết quả |
|---|---|
| TypeScript toàn workspace | PASS |
| Unit test shared core | PASS — 33 |
| Unit test Windows native | PASS — 20 |
| Unit test desktop shell sau sửa vòng đời app | PASS — 5 |
| Quay display/window, pause/resume, dừng ngay, dừng khi pause | PASS |
| System audio có tone thực, mic riêng, trộn audio | PASS về track/timeline; chưa đánh giá chất lượng giọng nói bằng người nghe |
| Move/resize/minimize/restore/close cửa sổ; display ID không tồn tại | PASS |
| Click chuột thật vào fixture, ghi tọa độ click trong vùng video | PASS |
| Quay liên tục 60 giây | PASS — manifest 60049 ms, MP4 60053 ms; không phải kiểm tra 30 phút/2 giờ |
| Quay và export qua đường dẫn có dấu tiếng Việt và khoảng trắng | PASS |
| Export native, trim, cursor, caption, mask, silent/invalid input, độ phân giải | PASS |
| Phụ đề offline EN/VI | PASS — khoảng 28.7/31.1 giây; VI fixture 3 lỗi/34 từ |
| Build NSIS cuối | PASS — 517479363 byte (493.51 MiB) |
| App đã cài khớp release | PASS — chỉ khác marker Tauri NSIS `UNK` → `NSS`; helper khớp hash |
| Model offline đã cài khớp nguồn | PASS — SHA-256 |
| E2E tự động trên app đã cài | PASS — UI-01 đến UI-10, không can thiệp thủ công |
| Restart, kích thước cửa sổ tối thiểu, caption đã sửa | PASS — caption còn nguyên sau restart |
| Gỡ bản QA | PASS — media/project/edits/exports còn nguyên SHA-256 |
| Cài lại sau khi gỡ | PASS — binary đã kiểm tra; toàn bộ dữ liệu trước đó còn nguyên |

Bằng chứng local (không commit media):

- Capture: `%TEMP%/screensway-capture-test-IN3V97`.
- Window cases: `%TEMP%/screensway-window-cases-wDowEs`.
- Window + physical click: `%TEMP%/screensway-window-cases-bHCcyb`.
- Export: `%TEMP%/screensway-export-test-LkhenZ`.
- Speech: `%TEMP%/screensway-speech-test-kO9zmY`.
- Quay 60 giây: `%TEMP%/screensway-capture-test-9Rimqw`.
- Unicode capture/export: `%TEMP%/screensway-quay thử-PpKGcP`,
  `%TEMP%/screensway-xuất video-1x6jW0`.
- UI cuối trên bản cài: `.tools/qa-windows-installer/ui/results.json` (10/10 PASS).
- Model đã cài: `.tools/qa-windows-installed-model.json`.
- Build: `.tools/qa-windows-installer-build.json`.
- Cài/gỡ/cài lại: `.tools/qa-windows-installer/results.json` (PASS).
- Các lần `.tools/qa-windows-rebuilt` và `qa-windows-final-release*` là lượt
  điều tra/sửa script trước đó, không dùng thay cho E2E cuối trên bản cài.

Installer: `apps/desktop/src-tauri/target/release/bundle/nsis/ScreenSway_0.3.0_x64-setup.exe`.
SHA-256: `cd365dd8dd9c11935e264255ab1e1371a1b354a49f7cb5a92661a54bb6d9fe97`.

## Vấn đề tìm thấy và xử lý

- Đóng cửa sổ chính sau khi quay có thể để lại tiến trình với HUD ẩn. Đã bổ sung
  xử lý vòng đời Windows: bảo vệ phiên quay đang chạy, dừng helper export/speech
  khi đóng, thoát app khi cửa sổ chính bị hủy. UI-09 trên bản cài cuối đã PASS.
- Bộ kiểm tra decode dùng timebase đầu ra mặc định, tạo lỗi DTS giả khi kiểm tra
  video VFR. Đã dùng `-fps_mode passthrough -enc_time_base demux -xerror`;
  chính video từng báo lỗi đã decode hết thành công sau sửa lệnh.
- UI test phụ đề dùng `Caption language` thay vì nhãn hiện tại `Spoken language`.
  Đã sửa script. Chọn option qua UI Automation dẫn đến lỗi ngôn ngữ;
  chọn bằng bàn phím đã xác nhận helper nhận `en-US`. Script hiện dùng bàn phím
  và xử lý control tạm thời không có tên trong lúc UI cập nhật.

## Các điều kiện chưa đủ bằng chứng

NOT RUN: Windows 10, AMD/NVIDIA, nhiều màn hình/mixed DPI, CPU không AVX2,
WebView2 chưa cài, mic bị từ chối/rút giữa phiên, thay audio endpoint, sleep/wake,
ổ đĩa đầy/quyền ghi bị thu hồi, crash recovery, quay 30 phút/2 giờ, nâng cấp từ
phiên bản cũ khác version, thao tác hoàn toàn bằng bàn phím và thử với người dùng mới.
Không được mô tả những mục này là đã đạt hoặc bảo đảm không bao giờ lỗi.

Bản cài unsigned; kiểm tra local không tạo chữ ký số hay chứng nhận SmartScreen.
Export và nhận dạng giọng nói dùng CPU, có thể lâu hơn thời lượng clip. Test
ngắn không chứng minh hiệu năng hay độ ổn định của phiên quay dài.
