/** A document reference returned by the Vault browser API. */
export interface KnowledgeTreeDocument {
  readonly id: string
  readonly title: string
  readonly version: number
  readonly updatedAt: string
  readonly categoryPath: string
}

/** One directory below a knowledge domain. */
export interface KnowledgeCategoryNode<T extends KnowledgeTreeDocument = KnowledgeTreeDocument> {
  readonly name: string
  readonly path: string
  readonly documents: T[]
  readonly children: KnowledgeCategoryNode<T>[]
}

/** Root documents and nested directories for one knowledge domain. */
export interface KnowledgeCategoryTree<T extends KnowledgeTreeDocument = KnowledgeTreeDocument> {
  readonly documents: T[]
  readonly categories: KnowledgeCategoryNode<T>[]
}

/**
 * Build the directory tree encoded by each document's category path.
 * @param documents - documents from one knowledge domain.
 * @returns root documents and directories sorted by title and Chinese display name.
 */
export function buildKnowledgeCategoryTree<T extends KnowledgeTreeDocument>(documents: readonly T[]): KnowledgeCategoryTree<T> {
  const root: KnowledgeCategoryNode<T> = { name: '', path: '', documents: [], children: [] }
  const nodes = new Map<string, KnowledgeCategoryNode<T>>([['', root]])

  for (const document of documents) {
    const parts = document.categoryPath.split('/').map(part => part.trim()).filter(part => part !== '')
    let parent = root
    let path = ''
    for (const part of parts) {
      path = path === '' ? part : `${path}/${part}`
      let node = nodes.get(path)
      if (node === undefined) {
        node = { name: part, path, documents: [], children: [] }
        nodes.set(path, node)
        parent.children.push(node)
      }
      parent = node
    }
    parent.documents.push(document)
  }

  sortDocuments(root.documents)
  sortCategories(root.children)
  return { documents: root.documents, categories: root.children }
}

/**
 * Count all documents stored at or below one category.
 * @param node - category whose descendants are counted.
 * @returns the recursive document count.
 */
export function countCategoryDocuments(node: KnowledgeCategoryNode): number {
  return node.documents.length + node.children.reduce((total, child) => total + countCategoryDocuments(child), 0)
}

function sortCategories<T extends KnowledgeTreeDocument>(categories: KnowledgeCategoryNode<T>[]): void {
  categories.sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'))
  for (const category of categories) {
    sortDocuments(category.documents)
    sortCategories(category.children)
  }
}

function sortDocuments(documents: KnowledgeTreeDocument[]): void {
  documents.sort((left, right) => left.title.localeCompare(right.title, 'zh-CN'))
}
