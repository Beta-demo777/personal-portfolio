import warnings
from dataclasses import dataclass
from pathlib import Path

from PIL import Image, UnidentifiedImageError


ALLOWED_IMAGE_FORMATS = {
    "JPEG": (".jpg", "image/jpeg"),
    "PNG": (".png", "image/png"),
    "WEBP": (".webp", "image/webp"),
    "GIF": (".gif", "image/gif"),
}


class InvalidImageError(ValueError):
    pass


@dataclass(frozen=True)
class VerifiedImage:
    extension: str
    content_type: str
    width: int
    height: int
    frames: int


def verify_image_file(
    path: Path,
    *,
    max_pixels: int,
    max_dimension: int,
    max_frames: int,
    max_total_pixels: int,
) -> VerifiedImage:
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(path) as image:
                image_format = image.format
                width, height = image.size
                if image_format not in ALLOWED_IMAGE_FORMATS:
                    raise InvalidImageError("Only JPG, PNG, WebP and GIF images are allowed")
                if width < 1 or height < 1:
                    raise InvalidImageError("Image dimensions are invalid")
                if width > max_dimension or height > max_dimension or width * height > max_pixels:
                    raise InvalidImageError("Image dimensions exceed the configured safety limit")
                declared_frames = getattr(image, "n_frames", 1)
                if declared_frames > max_frames:
                    raise InvalidImageError("Image frame count exceeds the configured safety limit")
                image.verify()

            # verify() checks structure without decoding pixels. Reopen and walk
            # every frame so corrupt animations and cumulative decode bombs are
            # rejected before the file is moved into the public media directory.
            with Image.open(path) as decoded:
                frame_count = 0
                total_pixels = 0
                while True:
                    frame_count += 1
                    frame_pixels = decoded.width * decoded.height
                    total_pixels += frame_pixels
                    if frame_count > max_frames:
                        raise InvalidImageError(
                            "Image frame count exceeds the configured safety limit"
                        )
                    if total_pixels > max_total_pixels:
                        raise InvalidImageError(
                            "Image total decoded pixels exceed the configured safety limit"
                        )
                    decoded.load()
                    try:
                        decoded.seek(decoded.tell() + 1)
                    except EOFError:
                        break
    except InvalidImageError:
        raise
    except (Image.DecompressionBombError, Image.DecompressionBombWarning) as error:
        raise InvalidImageError("Image dimensions exceed the configured safety limit") from error
    except (UnidentifiedImageError, OSError, SyntaxError, ValueError) as error:
        raise InvalidImageError("Uploaded file is not a valid supported image") from error

    extension, content_type = ALLOWED_IMAGE_FORMATS[image_format]
    return VerifiedImage(
        extension=extension,
        content_type=content_type,
        width=width,
        height=height,
        frames=frame_count,
    )
