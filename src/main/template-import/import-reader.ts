import * as nodeFs from 'fs'
import { isAbsolute, join, resolve, sep } from 'path'

import type { HarnessTemplateImportFolders } from '../../shared/state/harness-config'
import type { ImportFolderListing, TemplateImportListing } from './template-import'

export const MAX_IMPORT_FILE_BYTES = 1024 * 1024
export const MAX_IMPORT_ENTRIES = 5000
const MAX_DEPTH = 4

export type ImportReaderFilesystem = Pick<
  typeof nodeFs,
  'lstatSync' | 'statSync' | 'readdirSync' | 'readFileSync' | 'realpathSync'
>

export class TemplateImportReadError extends Error {}

function isInside(root: string, target: string): boolean {
  return target === root || target.startsWith(root + sep)
}

function realDirectory(fs: ImportReaderFilesystem, path: string, label: string): { root: string; realRoot: string } {
  if (!isAbsolute(path)) throw new TemplateImportReadError(`The ${label} folder must be an absolute path`)
  const root = resolve(path)
  try {
    if (!fs.statSync(root).isDirectory()) throw new Error('not a directory')
    return { root, realRoot: resolve(fs.realpathSync(root)) }
  } catch {
    throw new TemplateImportReadError(`The ${label} folder ${root} could not be read`)
  }
}

/** Reads one picked folder without modifying it (CON-001). Only
 *  markdown files are read; links are recorded, and a link into the
 *  shared references folder that names a folder is expanded to the
 *  files inside it. */
export function readImportFolder(
  fs: ImportReaderFilesystem,
  path: string,
  label: string,
  referencesRealRoot: string | null
): ImportFolderListing {
  const { root, realRoot } = realDirectory(fs, path, label)
  const listing: ImportFolderListing = { root, realRoot, files: {}, links: {}, skipped: [] }
  let count = 0
  const skip = (relativePath: string, message: string): void => {
    listing.skipped.push({ sourcePath: join(root, ...relativePath.split('/')), message })
  }

  const expandLinkedFolder = (relativePath: string, realDir: string, depth: number): void => {
    let entries: nodeFs.Dirent[]
    try {
      entries = fs.readdirSync(realDir, { withFileTypes: true })
    } catch {
      skip(relativePath, 'The linked folder could not be read')
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const childPath = `${relativePath}/${entry.name}`
      const childReal = join(realDir, entry.name)
      if (entry.isFile()) listing.links[childPath] = childReal
      else if (entry.isDirectory() && depth < MAX_DEPTH) expandLinkedFolder(childPath, childReal, depth + 1)
      else skip(childPath, 'Not a regular file')
    }
  }

  const walk = (relativeDir: string, depth: number): void => {
    const absoluteDir = relativeDir ? join(root, ...relativeDir.split('/')) : root
    let entries: nodeFs.Dirent[]
    try {
      entries = fs.readdirSync(absoluteDir, { withFileTypes: true })
    } catch {
      skip(relativeDir || '.', 'The folder could not be read')
      return
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (entry.name.startsWith('.')) continue
      count += 1
      if (count > MAX_IMPORT_ENTRIES) {
        throw new TemplateImportReadError(`The ${label} folder has more than ${MAX_IMPORT_ENTRIES} entries`)
      }
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name
      const absolutePath = join(absoluteDir, entry.name)
      if (entry.isSymbolicLink()) {
        let target: string
        let isDir = false
        try {
          target = resolve(fs.realpathSync(absolutePath))
          isDir = fs.statSync(target).isDirectory()
        } catch {
          skip(relativePath, 'Broken symbolic link')
          continue
        }
        if (!isDir) listing.links[relativePath] = target
        else if (referencesRealRoot && isInside(referencesRealRoot, target)) expandLinkedFolder(relativePath, target, depth)
        else skip(relativePath, 'Linked folder not followed')
      } else if (entry.isDirectory()) {
        if (depth < MAX_DEPTH) walk(relativePath, depth + 1)
        else skip(relativePath, 'Folder nested too deeply')
      } else if (entry.isFile()) {
        if (!entry.name.endsWith('.md')) {
          skip(relativePath, 'Not a markdown file')
          continue
        }
        try {
          if (fs.lstatSync(absolutePath).size > MAX_IMPORT_FILE_BYTES) {
            skip(relativePath, 'The file is larger than 1 MB')
            continue
          }
          listing.files[relativePath] = fs.readFileSync(absolutePath).toString('utf8')
        } catch {
          skip(relativePath, 'The file could not be read')
        }
      }
    }
  }

  walk('', 0)
  return listing
}

export function readTemplateImportListing(
  folders: HarnessTemplateImportFolders,
  fs: ImportReaderFilesystem = nodeFs
): TemplateImportListing {
  const references = folders.references ? readImportFolder(fs, folders.references, 'references', null) : null
  const referencesRealRoot = references?.realRoot ?? null
  const read = (path: string | null, label: string): ImportFolderListing | null =>
    path ? readImportFolder(fs, path, label, referencesRealRoot) : null
  return {
    agents: read(folders.agents, 'agents'),
    agentFragments: read(folders.agentFragments, 'agent fragments'),
    skills: folders.skills.map((path) => readImportFolder(fs, path, 'skills', referencesRealRoot)),
    references,
    commands: read(folders.commands, 'commands')
  }
}
