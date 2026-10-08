---
title: AI Usage Display — Product Card
doc_id: CARD-ai-usage-display
doc_type: product-card
verdict: showcase
version: 0.1
date: 2026-10-08
status: ร่างเพื่อพิจารณา
owner: Product owner (Book Dev)
---

# AI Usage Display — Product Card

## 1. สรุปคุณค่าในหนึ่งประโยค

ช่วยเจ้าของเห็นโควตาและการใช้งานของ AI หลายเจ้า (OpenAI/Codex, Anthropic, xAI, Kimi, Gemini) บนจอ ESP32 ขนาด 2.8 นิ้ว โดย key อยู่ที่ backend เท่านั้น

## 2. ปัญหาและผู้ใช้เป้าหมาย

- ผู้ใช้ AI หลายเจ้าต้องเปิดหลายหน้าเพื่อดูโควตาที่เหลือและเวลารีเซ็ต
- ผู้ใช้: เจ้าของคนเดียว (gadget ส่วนตัว)

## 3. สิ่งที่ทำได้จริงตอนนี้

- backend TypeScript มี adapter 14 ตัว (anthropic, openai, xai, kimi, gemini, claude-quota, subscription-quotas, solo-empire ฯลฯ) cache 60 วินาที และ route `GET /api/ai-usage` ที่ใช้ device token
- provider ที่ไม่มี API หรือไม่มี credential แสดง `status: "unavailable"` อย่างซื่อตรง
- อ่าน `ai_run_telemetry` ของ Solo Empire แบบอ่านอย่างเดียว (ทางเลือก)
- firmware `esp32-lvgl.ino` (~727 บรรทัด) แสดงผลด้วย LVGL; backend test 9 ไฟล์

## 4. หลักฐานสถานะ

- Stack: ไม่ตรวจพบ framework หลักจากตัวเก็บข้อเท็จจริง
- Commits: 10 (แรก 2026-08-11 → ล่าสุด 2026-10-01), branch `main`; working tree สะอาด
- Source: 40 ไฟล์ / 4,857 บรรทัด; test 16 ไฟล์
- CI: 1 workflow
- Deploy config: `docker-compose.yml`
- Live URL: ไม่พบใน repo

## 5. คุณค่าและจุดต่าง

- ออกแบบความปลอดภัยดี (ESP32 ไม่ถือ secret, ส่งเฉพาะเปอร์เซ็นต์และเวลารีเซ็ต)
- เป็นชิ้นงาน portfolio ที่ผสม hardware + backend ได้ดี; ขายเป็น kit ได้ **[สมมติฐาน]** แต่ตลาดเล็ก

## 6. ช่องว่างสำคัญ

- บาง quota อ่านจาก CLI ที่ล็อกอินอยู่บนเครื่อง จึงเปราะเมื่อผู้ให้บริการเปลี่ยนรูปแบบ
- ไม่มีหลักฐานว่าจอใช้งานต่อเนื่องอยู่ **[ต้องยืนยัน]**

## 7. คำตัดสิน

**showcase** — ทำงานจริงและเป็นหลักฐานความสามารถข้ามสาย (firmware + backend + security) แต่เป็น gadget ส่วนตัว ไม่ใช่ธุรกิจ

จะเป็น `invest` ถ้ามีผู้ใช้ภายนอกสนใจซื้อ kit หรือถ้าข้อมูลนี้กลายเป็นเครื่องมือคุมต้นทุน AI หลักของ Solo Empire

## 8. ขั้นต่อไป

1. ถ่ายภาพ/วิดีโอจอจริงใส่ README
2. ระบุ adapter ที่ใช้ได้จริงตอนนี้ในตาราง

## การอนุมัติ

| บทบาท | สถานะ | วันที่ | ลงนาม |
|---|---|---|---|
| Product owner (Book Dev) | รอพิจารณา | — | ________ |

## แหล่งข้อมูล

- `README.md`
- `backend/src/adapters/`
- `backend/src/routes/ai-usage.ts`
- `firmware/esp32-lvgl/esp32-lvgl.ino`
- `backend/tests/`
