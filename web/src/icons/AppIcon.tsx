import emptyApprovals from '../assets/icons/empty-approvals.webp'
import emptyFolder from '../assets/icons/empty-folder.webp'
import emptyRecycle from '../assets/icons/empty-recycle.webp'
import emptySearch from '../assets/icons/empty-search.webp'
import emptyUpload from '../assets/icons/empty-upload.webp'
import fileArchive from '../assets/icons/file-archive.webp'
import fileAudio from '../assets/icons/file-audio.webp'
import fileDeleted from '../assets/icons/file-deleted.webp'
import fileFolderDropbox from '../assets/icons/file-folder-dropbox.webp'
import fileFolderTraversable from '../assets/icons/file-folder-traversable.webp'
import fileFolder from '../assets/icons/file-folder.webp'
import fileGeneric from '../assets/icons/file-generic.webp'
import fileImage from '../assets/icons/file-image.webp'
import filePdf from '../assets/icons/file-pdf.webp'
import fileSheet from '../assets/icons/file-sheet.webp'
import fileSlides from '../assets/icons/file-slides.webp'
import fileText from '../assets/icons/file-text.webp'
import fileVideo from '../assets/icons/file-video.webp'
import fileWord from '../assets/icons/file-word.webp'
import healthDegraded from '../assets/icons/health-degraded.webp'
import healthOk from '../assets/icons/health-ok.webp'
import policyOfficeEdit from '../assets/icons/policy-office-edit.webp'
import policyUploadGuard from '../assets/icons/policy-upload-guard.webp'
import serviceCache from '../assets/icons/service-cache.webp'
import serviceDatabase from '../assets/icons/service-database.webp'
import serviceStorage from '../assets/icons/service-storage.webp'

const iconSources = {
  'file-folder': fileFolder,
  'file-folder-dropbox': fileFolderDropbox,
  'file-folder-traversable': fileFolderTraversable,
  'file-word': fileWord,
  'file-sheet': fileSheet,
  'file-slides': fileSlides,
  'file-pdf': filePdf,
  'file-text': fileText,
  'file-image': fileImage,
  'file-video': fileVideo,
  'file-audio': fileAudio,
  'file-archive': fileArchive,
  'file-generic': fileGeneric,
  'file-deleted': fileDeleted,
  'empty-upload': emptyUpload,
  'empty-folder': emptyFolder,
  'empty-search': emptySearch,
  'empty-recycle': emptyRecycle,
  'empty-approvals': emptyApprovals,
  'health-ok': healthOk,
  'health-degraded': healthDegraded,
  'service-database': serviceDatabase,
  'service-storage': serviceStorage,
  'service-cache': serviceCache,
  'policy-office-edit': policyOfficeEdit,
  'policy-upload-guard': policyUploadGuard,
} as const

export type AppIconName = keyof typeof iconSources

export function AppIcon({
  name,
  size,
  className,
  alt = '',
}: {
  name: AppIconName
  size: number
  className?: string
  alt?: string
}) {
  const classes = className ? `app-icon ${className}` : 'app-icon'
  return (
    <img
      src={iconSources[name]}
      width={size}
      height={size}
      alt={alt}
      aria-hidden={alt === '' ? true : undefined}
      className={classes}
      decoding="async"
      draggable={false}
    />
  )
}
