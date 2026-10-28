#!/usr/bin/env python3
import sys
import json
import base64
import ddddocr

def recognize_captcha(base64_image):
    """识别验证码"""
    try:
        # 解码 base64 图片
        image_data = base64.b64decode(base64_image)
        
        # 初始化 ddddocr
        ocr = ddddocr.DdddOcr(show_ad=False)
        
        # 识别验证码
        result = ocr.classification(image_data)
        
        return result
    except Exception as e:
        return None

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"success": False, "error": "缺少 base64 图片参数"}))
        sys.exit(1)
    
    base64_image = sys.argv[1]
    result = recognize_captcha(base64_image)
    
    if result:
        print(json.dumps({"success": True, "code": result}))
    else:
        print(json.dumps({"success": False, "error": "识别失败"}))
