import { describe, it, expect } from 'vitest'
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveProjectFile } from '../electron/project-files.js'

describe('project file boundary', () => {
  it('reveals project files but rejects outside paths and symlink escapes', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'edict-files-'))
    try {
      const project = join(temporary, 'project')
      await mkdir(project)
      await writeFile(join(project, 'report.md'), 'test')
      await writeFile(join(temporary, 'outside.md'), 'test')
      expect(await resolveProjectFile(project, 'report.md')).toMatch(/report.md$/)
      await expect(resolveProjectFile(project, '../outside.md')).rejects.toThrow('当前项目')
      await symlink(join(temporary, 'outside.md'), join(project, 'link.md'))
      await expect(resolveProjectFile(project, 'link.md')).rejects.toThrow('当前项目')
    } finally { await rm(temporary, { recursive: true, force: true }) }
  })
})
