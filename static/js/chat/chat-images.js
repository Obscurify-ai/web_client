// chat-images.js — Image attachment preview + validation. Owns base64Images
// (the outbound payload) and imageByteSizes (running total for size cap).
// Creates imagePreviewContainer at load and appends thumbnails with remove
// buttons, then the chips of attached documents (chat-files.js).
// handleImageChange is the change handler wired to both landing and chat
// attach inputs; anything that isn't an image goes to attachDocuments.

const MAX_IMAGE_FILE_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_ATTACHMENTS = 4;
const ALLOWED_IMAGE_MIME_TYPES = new Set([
    'image/png',
    'image/jpeg',
    'image/jpg',
    'image/webp',
    'image/gif'
]);

let base64Images = null;
let imageByteSizes = null;

// Create image preview container (starts in landing input)
const imagePreviewContainer = document.createElement('div');
imagePreviewContainer.id = 'image-preview-container';
imagePreviewContainer.className = 'image-preview-container';
document.getElementById('input-container').insertBefore(imagePreviewContainer, landingPromptInput);

function updateImagePreviews() {
    imagePreviewContainer.innerHTML = '';
    if (base64Images && base64Images.length > 0) {
        base64Images.forEach((imgData, index) => {
            const previewWrapper = document.createElement('div');
            previewWrapper.className = 'image-preview-wrapper';

            const img = document.createElement('img');
            img.src = imgData;
            img.className = 'image-preview';
            img.alt = 'Attached image ' + (index + 1);

            const removeBtn = document.createElement('button');
            removeBtn.className = 'image-preview-remove';
            removeBtn.innerHTML = '&times;';
            removeBtn.type = 'button';
            removeBtn.onclick = function() {
                base64Images.splice(index, 1);
                if (imageByteSizes) {
                    imageByteSizes.splice(index, 1);
                }
                updateImagePreviews();
            };

            previewWrapper.appendChild(img);
            previewWrapper.appendChild(removeBtn);
            imagePreviewContainer.appendChild(previewWrapper);
        });
    }
    const docCount = typeof renderDocChips === 'function' ? renderDocChips(imagePreviewContainer) : 0;
    const imageCount = base64Images ? base64Images.length : 0;
    imagePreviewContainer.style.display = imageCount + docCount > 0 ? 'flex' : 'none';
}

// Base64 encode images - handler for both image inputs
function handleImageChange(inputEl) {
    const picked = Array.from(inputEl.files);
    const files = picked.filter(f => ALLOWED_IMAGE_MIME_TYPES.has(f.type));
    const docs = picked.filter(f => !ALLOWED_IMAGE_MIME_TYPES.has(f.type));
    if (docs.length > 0) attachDocuments(docs);
    if (!base64Images) base64Images = [];
    if (!imageByteSizes) imageByteSizes = [];

    const validationErrors = [];
    const validFiles = [];
    let runningTotalBytes = imageByteSizes.reduce((sum, size) => sum + size, 0);

    files.forEach(file => {
        if (!file) return;

        if (base64Images.length + validFiles.length >= MAX_IMAGE_ATTACHMENTS) {
            validationErrors.push(`Maximum ${MAX_IMAGE_ATTACHMENTS} images allowed.`);
            return;
        }

        if (file.size > MAX_IMAGE_FILE_BYTES) {
            validationErrors.push(`"${file.name}" exceeds 20 MB.`);
            return;
        }

        if (runningTotalBytes + file.size > MAX_TOTAL_IMAGE_BYTES) {
            validationErrors.push('Total image payload cannot exceed 20 MB.');
            return;
        }

        runningTotalBytes += file.size;
        validFiles.push(file);
    });

    if (validationErrors.length > 0) {
        alert(validationErrors.join('\n'));
    }

    let loadedCount = 0;
    const totalFiles = validFiles.length;

    validFiles.forEach(file => {
        if (file) {
            const reader = new FileReader();
            reader.onload = function (event) {
                base64Images.push(event.target.result);
                imageByteSizes.push(file.size);
                loadedCount++;
                if (loadedCount === totalFiles) {
                    updateImagePreviews();
                }
            };
            reader.readAsDataURL(file);
        }
    });

    if (totalFiles === 0) {
        updateImagePreviews();
    }

    // Reset the input so the same file can be selected again
    inputEl.value = '';
}

landingImageInput.addEventListener('change', function () { handleImageChange(this); });
chatImageInput.addEventListener('change', function () { handleImageChange(this); });
