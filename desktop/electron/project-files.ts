import { realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

/** Resolve inside the current project, including symlinks. Never accept URLs. */
export async function resolveProjectFile(project: string, requested: string): Promise<string> {
  const root = await realpath(project)
  const file = await realpath(resolve(root, requested))
  const rel = relative(root, file)
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('只能查看当前项目内的文件')
  return file
}
