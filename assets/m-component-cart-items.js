import { Component } from '@theme/component';
import {
  fetchConfig,
  debounce,
  onAnimationEnd,
  prefersReducedMotion,
  resetShimmer,
  startViewTransition,
} from '@theme/utilities';
import { morphSection, sectionRenderer } from '@theme/section-renderer';
import {
  ThemeEvents,
  CartUpdateEvent,
  QuantitySelectorUpdateEvent,
  CartAddEvent,
  DiscountUpdateEvent,
} from '@theme/events';
import { cartPerformance } from '@theme/performance';

/** @typedef {import('./utilities').TextComponent} TextComponent */

/**
 * A custom element that displays a cart items component.
 *
 * @typedef {object} Refs
 * @property {HTMLElement[]} quantitySelectors - The quantity selector elements.
 * @property {HTMLTableRowElement[]} cartItemRows - The cart item rows.
 * @property {TextComponent} cartTotal - The cart total.
 *
 * @extends {Component<Refs>}
 */
class CartItemsComponent extends Component {
  #debouncedOnChange = debounce(this.#onQuantityChange, 300).bind(this);

  connectedCallback() {
    super.connectedCallback();

    document.addEventListener(ThemeEvents.cartUpdate, this.#handleCartUpdate);
    document.addEventListener(ThemeEvents.discountUpdate, this.handleDiscountUpdate);
    document.addEventListener(ThemeEvents.quantitySelectorUpdate, this.#debouncedOnChange);
  }

  disconnectedCallback() {
    super.disconnectedCallback();

    document.removeEventListener(ThemeEvents.cartUpdate, this.#handleCartUpdate);
    document.removeEventListener(ThemeEvents.discountUpdate, this.handleDiscountUpdate);
    document.removeEventListener(ThemeEvents.quantitySelectorUpdate, this.#debouncedOnChange);
  }

  /**
   * Handles QuantitySelectorUpdateEvent change event.
   * @param {QuantitySelectorUpdateEvent} event - The event.
   */
  #onQuantityChange(event) {
    if (!(event.target instanceof Node) || !this.contains(event.target)) return;

    const { quantity, cartLine: line } = event.detail;

    // Cart items require a line number
    if (!line) return;

    if (quantity === 0) {
      return this.onLineItemRemove(line);
    }

    this.updateQuantity({
      line,
      quantity,
      action: 'change',
    });
    const lineItemRow = this.refs.cartItemRows[line - 1];

    if (!lineItemRow) return;

    const textComponent = /** @type {TextComponent | undefined} */ (lineItemRow.querySelector('text-component'));
    textComponent?.shimmer();
  }

  /**
   * Handles the line item removal.
   * @param {number} line - The line item index.
   */
  onLineItemRemove(line) {
    this.updateQuantity({
      line,
      quantity: 0,
      action: 'clear',
    });

    const cartItemRowToRemove = this.refs.cartItemRows[line - 1];

    if (!cartItemRowToRemove) return;

    const rowsToRemove = [
      cartItemRowToRemove,
      // Get all nested lines of the row to remove
      ...this.refs.cartItemRows.filter((row) => row.dataset.parentKey === cartItemRowToRemove.dataset.key),
    ];

    // If the cart item row is the last row, optimistically trigger the cart empty state
    const isEmptyCart = rowsToRemove.length == this.refs.cartItemRows.length;

    const template = document.getElementById('empty-cart-template');
    if (isEmptyCart && template instanceof HTMLTemplateElement) {
      const clone = document.importNode(template.content, true);

      startViewTransition(() => {
        this.replaceChildren(clone);
      }, [this.isDrawer ? 'empty-cart-drawer' : 'empty-cart-page']);

      return;
    }

    // Add class to the row to trigger the animation
    rowsToRemove.forEach((row) => {
      const remove = () => row.remove();

      if (prefersReducedMotion()) return remove();

      row.style.setProperty('--row-height', `${row.clientHeight}px`);
      row.classList.add('removing');

      // Remove the row after the animation ends
      onAnimationEnd(row, remove);
    });
  }

  /**
   * Updates the quantity.
   * @param {Object} config - The config.
   * @param {number} config.line - The line.
   * @param {number} config.quantity - The quantity.
   * @param {string} config.action - The action.
   */
  updateQuantity(config) {
    const cartPerformaceUpdateMarker = cartPerformance.createStartingMarker(`${config.action}:user-action`);

    this.#disableCartItems();

    const { line, quantity } = config;
    const { cartTotal } = this.refs;

    const cartItemsComponents = document.querySelectorAll('cart-items-component');
    const sectionsToUpdate = new Set([this.sectionId]);
    cartItemsComponents.forEach((item) => {
      if (item instanceof HTMLElement && item.dataset.sectionId) {
        sectionsToUpdate.add(item.dataset.sectionId);
      }
    });

    const body = JSON.stringify({
      line: line,
      quantity: quantity,
      sections: Array.from(sectionsToUpdate).join(','),
      sections_url: window.location.pathname,
    });

    cartTotal?.shimmer();

    fetch(`${Theme.routes.cart_change_url}`, fetchConfig('json', { body }))
      .then((response) => {
        return response.text();
      })
      .then((responseText) => {
        const parsedResponseText = JSON.parse(responseText);

        resetShimmer(this);

        if (parsedResponseText.errors) {
          this.#handleCartError(line, parsedResponseText);
          return;
        }

        const newSectionHTML = new DOMParser().parseFromString(
          parsedResponseText.sections[this.sectionId],
          'text/html'
        );

        // Grab the new cart item count from a hidden element
        const newCartHiddenItemCount = newSectionHTML.querySelector('[ref="cartItemCount"]')?.textContent;
        const newCartItemCount = newCartHiddenItemCount ? parseInt(newCartHiddenItemCount, 10) : 0;

        // Update data-cart-quantity for all matching variants
        this.#updateQuantitySelectors(parsedResponseText);

        this.dispatchEvent(
          new CartUpdateEvent(parsedResponseText, this.sectionId, {
            itemCount: newCartItemCount,
            source: 'cart-items-component',
            sections: parsedResponseText.sections,
          })
        );

        morphSection(this.sectionId, parsedResponseText.sections[this.sectionId], { mode: this.isDrawer ? 'hydration' : 'full' });

        this.#updateCartQuantitySelectorButtonStates();
      })
      .catch((error) => {
        console.error(error);
      })
      .finally(() => {
        this.#enableCartItems();
        cartPerformance.measureFromMarker(cartPerformaceUpdateMarker);
      });
  }

  /**
   * Handles the discount update.
   * @param {DiscountUpdateEvent} event - The event.
   */
  handleDiscountUpdate = (event) => {
    this.#handleCartUpdate(event);
  };

  /**
   * Handles the cart error.
   * @param {number} line - The line.
   * @param {Object} parsedResponseText - The parsed response text.
   * @param {string} parsedResponseText.errors - The errors.
   */
  #handleCartError = (line, parsedResponseText) => {
    const quantitySelector = this.refs.quantitySelectors[line - 1];
    const quantityInput = quantitySelector?.querySelector('input');

    if (!quantityInput) throw new Error('Quantity input not found');

    quantityInput.value = quantityInput.defaultValue;

    const cartItemError = this.refs[`cartItemError-${line}`];
    const cartItemErrorContainer = this.refs[`cartItemErrorContainer-${line}`];

    if (!(cartItemError instanceof HTMLElement)) throw new Error('Cart item error not found');
    if (!(cartItemErrorContainer instanceof HTMLElement)) throw new Error('Cart item error container not found');

    cartItemError.textContent = parsedResponseText.errors;
    cartItemErrorContainer.classList.remove('hidden');
  };

  /**
   * Handles the cart update.
   *
   * @param {DiscountUpdateEvent | CartUpdateEvent | CartAddEvent} event
   */
  #handleCartUpdate = (event) => {
    if (event instanceof DiscountUpdateEvent) {
      sectionRenderer.renderSection(this.sectionId, { cache: false });
      return;
    }

    const isFreeGiftEvent = event.detail?.data?.source === 'free-gift';
    const isOwnCartItemsEvent = event.target === this && event.detail?.data?.source === 'cart-items-component';

    // Only perform DOM morph for non-own cart-items events. Own cart item operations already morph directly.
    if (!isOwnCartItemsEvent) {
      const cartItemsHtml = event.detail.data.sections?.[this.sectionId];
      if (cartItemsHtml) {
        morphSection(this.sectionId, cartItemsHtml);

        // Update button states for all cart quantity selectors after morph
        this.#updateCartQuantitySelectorButtonStates();
      } else {
        sectionRenderer.renderSection(this.sectionId, { cache: false });
      }
    }

    const cart = event.detail.resource;
    if (!isFreeGiftEvent && cart?.items) {
      this.#checkFreeGiftThreshold(cart);
    }
  };

  /**
   * Disables the cart items.
   */
  #disableCartItems() {
    this.classList.add('cart-items-disabled');
  }

  /**
   * Enables the cart items.
   */
  #enableCartItems() {
    this.classList.remove('cart-items-disabled');
  }

  /**
   * Updates quantity selectors for all matching variants in the cart.
   * @param {Object} updatedCart - The updated cart object.
   * @param {Array<{variant_id: number, quantity: number}>} [updatedCart.items] - The cart items.
   */
  #updateQuantitySelectors(updatedCart) {
    if (!updatedCart.items) return;

    for (const item of updatedCart.items) {
      const variantId = item.variant_id.toString();
      const selectors = document.querySelectorAll(`quantity-selector-component[data-variant-id="${variantId}"]`);

      for (const selector of selectors) {
        const input = selector.querySelector('input[data-cart-quantity]');
        if (!input) continue;

        input.setAttribute('data-cart-quantity', item.quantity.toString());

        // Update the quantity selector's internal state
        if ('updateCartQuantity' in selector && typeof selector.updateCartQuantity === 'function') {
          selector.updateCartQuantity();
        }
      }
    }
  }

  /**
   * Updates button states for all cart quantity selector components.
   */
  #updateCartQuantitySelectorButtonStates() {
    for (const selector of document.querySelectorAll('cart-quantity-selector-component')) {
      /** @type {any} */ (selector).updateButtonStates?.();
    }
  }

  /**
   * Gets the free-gift variant ID from Theme config.
   * @returns {string}
   */
  #getGiftVariantId() {
    const giftVariantId = Theme.freeGift?.variantId;

    if (!giftVariantId) throw new Error('Gift variant id missing');

    return giftVariantId;
  }

  #getCartSectionIds() {
    const cartItems = document.querySelectorAll('cart-items-component');
    const sectionIds = new Set([this.sectionId]);

    cartItems.forEach((item) => {
      if (item instanceof HTMLElement && item.dataset.sectionId) {
        sectionIds.add(item.dataset.sectionId);
      }
    });

    return Array.from(sectionIds).join(',');
  }

  /**
   * Adds the free gift to the cart.
   */
  #addFreeGift() {
    const sections = this.#getCartSectionIds();
    const body = JSON.stringify({
      items: [{
        id: Number(this.#getGiftVariantId()),
        quantity: 1,
        properties: { _free_gift: 'true' },
      }],
      sections,
      sections_url: window.location.pathname,
    });

    fetch(Theme.routes.cart_add_url, fetchConfig('json', { body }))
      .then((response) => response.text())
      .then((responseText) => {
        const data = JSON.parse(responseText);

        if (data.status) {
          return;
        }

        if (data.sections?.[this.sectionId]) {
          morphSection(this.sectionId, data.sections[this.sectionId], {
            mode: this.isDrawer ? 'hydration' : 'full',
          });
          this.#updateCartQuantitySelectorButtonStates();
        }

        document.dispatchEvent(
          new CartUpdateEvent(data, this.id, {
            source: 'free-gift',
            sections: data.sections,
            itemCount: data.item_count,
          })
        );
      })
      .catch((error) => {
        console.error('[free-gift] add failed', error);
      });
  }

  /**
   * Removes the free gift from the cart.
   * @param {Object} cart
   * @param {Array<{variant_id: number, quantity: number, properties: {_free_gift: string}}>} [cart.items] - The cart items.
   * @param {number} [cart.total_price] - The cart total price.
   * @param {number} [cart.item_count] - The cart item count.
   */
  #removeFreeGift(cart) {
    if (!cart.items) return;

    const giftLine = cart.items.findIndex((item) => item.properties?._free_gift === 'true');
    if (giftLine === -1) return;

    const sections = this.#getCartSectionIds();
    const body = JSON.stringify({
      line: giftLine + 1,
      quantity: 0,
      sections,
      sections_url: window.location.pathname,
    });

    fetch(Theme.routes.cart_change_url, fetchConfig('json', { body }))
      .then((response) => response.text())
      .then((responseText) => {
        const data = JSON.parse(responseText);

        if (data.status) {
          return;
        }

        if (data.sections?.[this.sectionId]) {
          morphSection(this.sectionId, data.sections[this.sectionId], {
            mode: this.isDrawer ? 'hydration' : 'full',
          });
          this.#updateCartQuantitySelectorButtonStates();
        }

        document.dispatchEvent(
          new CartUpdateEvent(data, this.id, {
            source: 'free-gift',
            sections: data.sections,
            itemCount: data.item_count,
          })
        );
      })
      .catch((error) => {
        console.error('[free-gift] remove failed', error);
      });
  }

  /**
   * Checks gift threshold and acts accordingly.
   * @param {Object} cart
   * @param {Array<{variant_id: number, quantity: number, properties: {_free_gift: string}}>} [cart.items] - The cart items.
   * @param {number} [cart.total_price] - The cart total price.
   * @param {number} [cart.item_count] - The cart item count.
   */
  #checkFreeGiftThreshold(cart) {
    if (!cart.items || typeof cart.total_price !== 'number') return;

    if (!Theme.freeGift?.enabled) return;
    const threshold = Number(Theme.freeGift.threshold) * 100;
    const subtotal = Number(cart.total_price);

    const hasGift = cart.items?.some((item) => item.properties?._free_gift === 'true');

    if (subtotal >= threshold && !hasGift) {
      this.#addFreeGift();
    }

    if (subtotal < threshold && hasGift) {
      this.#removeFreeGift(cart);
    }
  }

  /**
   * Gets the section id.
   * @returns {string} The section id.
   */
  get sectionId() {
    const { sectionId } = this.dataset;

    if (!sectionId) throw new Error('Section id missing');

    return sectionId;
  }

  /**
   * @returns {boolean} Whether the component is a drawer.
   */
  get isDrawer() {
    return this.dataset.drawer !== undefined;
  }
}

if (!customElements.get('cart-items-component')) {
  customElements.define('cart-items-component', CartItemsComponent);
}
