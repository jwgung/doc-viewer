; 이 파일은 desktop/scripts/make-file-icons.js가 만든다. 손으로 고치지 말고 스크립트를 고쳐 다시 실행한다.
!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr SHCTX "Software\Classes\DocViewer.pdf\DefaultIcon" "" "$INSTDIR\icons\files\pdf.ico"
  WriteRegStr SHCTX "Software\Classes\DocViewer.hwp\DefaultIcon" "" "$INSTDIR\icons\files\hwp.ico"
  WriteRegStr SHCTX "Software\Classes\DocViewer.hwpx\DefaultIcon" "" "$INSTDIR\icons\files\hwpx.ico"
  WriteRegStr SHCTX "Software\Classes\DocViewer.doc\DefaultIcon" "" "$INSTDIR\icons\files\doc.ico"
  WriteRegStr SHCTX "Software\Classes\DocViewer.docx\DefaultIcon" "" "$INSTDIR\icons\files\docx.ico"
  WriteRegStr SHCTX "Software\Classes\DocViewer.xls\DefaultIcon" "" "$INSTDIR\icons\files\xls.ico"
  WriteRegStr SHCTX "Software\Classes\DocViewer.xlsx\DefaultIcon" "" "$INSTDIR\icons\files\xlsx.ico"
  WriteRegStr SHCTX "Software\Classes\DocViewer.csv\DefaultIcon" "" "$INSTDIR\icons\files\csv.ico"
  WriteRegStr SHCTX "Software\Classes\DocViewer.ppt\DefaultIcon" "" "$INSTDIR\icons\files\ppt.ico"
  WriteRegStr SHCTX "Software\Classes\DocViewer.pptx\DefaultIcon" "" "$INSTDIR\icons\files\pptx.ico"
  WriteRegStr SHCTX "Software\Classes\DocViewer.md\DefaultIcon" "" "$INSTDIR\icons\files\md.ico"
  WriteRegStr SHCTX "Software\Classes\DocViewer.txt\DefaultIcon" "" "$INSTDIR\icons\files\txt.ico"
  WriteRegStr SHCTX "Software\Classes\DocViewer.log\DefaultIcon" "" "$INSTDIR\icons\files\log.ico"
  WriteRegStr SHCTX "Software\Classes\DocViewer.json\DefaultIcon" "" "$INSTDIR\icons\files\json.ico"
  WriteRegStr SHCTX "Software\Classes\DocViewer.xml\DefaultIcon" "" "$INSTDIR\icons\files\xml.ico"
  WriteRegStr SHCTX "Software\Classes\DocViewer.toml\DefaultIcon" "" "$INSTDIR\icons\files\toml.ico"
  WriteRegStr SHCTX "Software\Classes\DocViewer.yaml\DefaultIcon" "" "$INSTDIR\icons\files\yaml.ico"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
