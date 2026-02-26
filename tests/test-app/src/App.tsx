import { BrowserRouter, NavLink, Route, Routes } from 'react-router-dom'
import { IndexPage } from './pages/IndexPage'
import { FormsPage } from './pages/FormsPage'
import { DataPage } from './pages/DataPage'
import { OverlaysPage } from './pages/OverlaysPage'
import { DynamicPage } from './pages/DynamicPage'
import { VisibilityPage } from './pages/VisibilityPage'
import { CustomWidgetsPage } from './pages/CustomWidgetsPage'
import { IframePage } from './pages/IframePage'
import { IframeContentPage } from './pages/IframeContent'
import { ScrollPage } from './pages/ScrollPage'
import { NavigationPage } from './pages/NavigationPage'
import { NavigationChurnPage } from './pages/NavigationChurnPage'
import { ShadowDomPage } from './pages/ShadowDomPage'
import { ProductCatalogPage } from './pages/ProductCatalogPage'
import { ProductContextsPage } from './pages/ProductContextsPage'
import { IframeProductsPage } from './pages/IframeProductsPage'
import { ComplexLoadingPage } from './pages/ComplexLoadingPage'

const links = [
    { to: '/', label: 'Index' },
    { to: '/forms', label: 'Forms' },
    { to: '/data', label: 'Data' },
    { to: '/overlays', label: 'Overlays' },
    { to: '/dynamic', label: 'Dynamic' },
    { to: '/visibility', label: 'Visibility' },
    { to: '/widgets', label: 'Widgets' },
    { to: '/iframe', label: 'Iframe' },
    { to: '/shadow', label: 'Shadow' },
    { to: '/products', label: 'Products' },
    { to: '/products-contexts', label: 'Product Contexts' },
    { to: '/complex-loading', label: 'Complex Loading' },
    { to: '/scroll', label: 'Scroll' },
    { to: '/navigation', label: 'Navigation' },
    { to: '/navigation-churn', label: 'Nav Churn' },
]

export function App(): JSX.Element {
    return (
        <BrowserRouter>
            <div className="min-h-screen">
                <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/80 backdrop-blur">
                    <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-2 px-4 py-3">
                        <p className="mr-4 text-sm font-semibold tracking-[0.12em] text-slate-500">
                            OPENSTEER TEST APP
                        </p>
                        {links.map((link) => (
                            <NavLink
                                key={link.to}
                                to={link.to}
                                className={({ isActive }) =>
                                    `rounded-full px-3 py-1 text-xs font-medium transition ${
                                        isActive
                                            ? 'bg-teal-700 text-white'
                                            : 'bg-white text-slate-600 hover:bg-slate-100'
                                    }`
                                }
                            >
                                {link.label}
                            </NavLink>
                        ))}
                    </div>
                </header>

                <Routes>
                    <Route path="/" element={<IndexPage />} />
                    <Route path="/forms" element={<FormsPage />} />
                    <Route path="/data" element={<DataPage />} />
                    <Route path="/overlays" element={<OverlaysPage />} />
                    <Route path="/dynamic" element={<DynamicPage />} />
                    <Route path="/visibility" element={<VisibilityPage />} />
                    <Route path="/widgets" element={<CustomWidgetsPage />} />
                    <Route path="/iframe" element={<IframePage />} />
                    <Route
                        path="/iframe/content"
                        element={<IframeContentPage />}
                    />
                    <Route
                        path="/iframe/products"
                        element={<IframeProductsPage />}
                    />
                    <Route path="/shadow" element={<ShadowDomPage />} />
                    <Route path="/products" element={<ProductCatalogPage />} />
                    <Route
                        path="/products-contexts"
                        element={<ProductContextsPage />}
                    />
                    <Route
                        path="/complex-loading"
                        element={<ComplexLoadingPage />}
                    />
                    <Route
                        path="/complex-loading/results"
                        element={<ComplexLoadingPage />}
                    />
                    <Route path="/scroll" element={<ScrollPage />} />
                    <Route path="/navigation" element={<NavigationPage />} />
                    <Route
                        path="/navigation-churn"
                        element={<NavigationChurnPage />}
                    />
                </Routes>
            </div>
        </BrowserRouter>
    )
}
