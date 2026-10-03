# Third-party notices

The [MIT license](LICENSE) covers BridgeClip-owned clipping engine source. The following bundled files have separate terms. Keep their license files when redistributing the engine or an app that includes it.

| Component | Included files | Source and terms |
| --- | --- | --- |
| Montserrat | `assets/fonts/Montserrat-Black.ttf`, `Montserrat-ExtraBold.ttf` | [Google Fonts Montserrat](https://github.com/google/fonts/tree/main/ofl/montserrat), SIL Open Font License 1.1; text in `assets/fonts/Montserrat-OFL.txt`. |
| Anton | `assets/fonts/Anton-Regular.ttf` | [Google Fonts Anton](https://github.com/google/fonts/tree/main/ofl/anton), SIL Open Font License 1.1; text in `assets/fonts/Anton-OFL.txt`. |
| Archivo Black | `assets/fonts/ArchivoBlack-Regular.ttf` | [Google Fonts Archivo Black](https://github.com/google/fonts/tree/main/ofl/archivoblack), SIL Open Font License 1.1; text in `assets/fonts/ArchivoBlack-OFL.txt`. |
| Instrument Serif | `assets/fonts/InstrumentSerif-Italic.ttf` | [Google Fonts Instrument Serif](https://github.com/google/fonts/tree/main/ofl/instrumentserif), SIL Open Font License 1.1; text in `assets/fonts/InstrumentSerif-OFL.txt`. |
| Poppins | `assets/fonts/Poppins-Black.ttf`, `Poppins-ExtraBold.ttf` | [Google Fonts Poppins](https://github.com/google/fonts/tree/main/ofl/poppins), SIL Open Font License 1.1; text in `assets/fonts/Poppins-OFL.txt`. |
| Plus Jakarta Sans | `assets/fonts/PlusJakartaSans.ttf` | [Plus Jakarta Sans](https://github.com/tokotype/PlusJakartaSans), SIL Open Font License 1.1; text in `assets/fonts/PlusJakartaSans-OFL.txt`. |
| YuNet face detector | `assets/models/face_detection_yunet_2023mar.onnx` | [OpenCV Zoo YuNet](https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet), MIT; text in `assets/models/YuNet-LICENSE`. The model file was checked byte for byte against the upstream copy during this review. |
| YAMNet audio event classifier | `assets/models/yamnet.onnx`, `assets/models/yamnet_class_map.csv` | Google's [YAMNet](https://github.com/tensorflow/models/tree/master/research/audioset/yamnet), Apache License 2.0; text in `assets/models/YAMNet-LICENSE`. The ONNX file is the `tf2onnx` conversion published at [audiomagic/yamnet-onnx](https://huggingface.co/audiomagic/yamnet-onnx) (commit `f25b741c2f0bdc6d7e6db24b5fddda23347dbafd`, SHA-256 `d3835ffbbd4a1bb3e777f0ca217b5007907f5171dd5d17c4236b95b2af8f908e`). Class names come from the [AudioSet ontology](https://research.google.com/audioset/), CC BY 4.0. |

Python dependencies are pinned with hashes in `requirements.lock`. Their individual licenses are determined by the package distributions and are not replaced by the BridgeClip MIT license. The desktop release also includes Python, yt-dlp, FFmpeg and their notices; see the root `THIRD_PARTY_NOTICES.md` and `docs/RELEASING.md`.

No third-party platform logos are bundled. Names and trademarks remain with their owners. Before a public binary release, review the actual built package, dependency license inventory and ownership of original source and artwork.
